import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobberWebSession } from '../../worker/src/services/jobber-web-session.js';
import { OpsAssistantRead } from '../../worker/src/services/ops-assistant-read.js';
import { readAssistantRequestContext } from '../../worker/src/services/assistant-request-context.js';
import { createMockD1, configurePrepareResults } from './helpers/mock-d1.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('assistant request form context', () => {
  it('includes submitted referral and scope answers, distinct from notes', async () => {
    vi.spyOn(JobberWebSession.prototype, 'fetchRequestFormData').mockResolvedValue({
      sessionExpired: false, formData: {
        text: 'How did you hear about us?: Google\nWork requested: Repair water damage',
        sections: [{ label: 'Request', sortOrder: 1, answers: [
          { label: 'How did you hear about us?', value: 'Google' },
          { label: 'Work requested', value: 'Repair water damage' },
        ] }], truncated: false,
      },
    });
    const read = new OpsAssistantRead({ graphqlRequest: vi.fn().mockResolvedValue({
      request: { id: 'req-1', title: 'Water damage', notes: { edges: [] } },
    }) }, createMockD1() as never);
    const result = await read.readRequest('user-a', { requestId: 'req-1' });
    expect(result.outcome).toBe('ok');
    if (!result.request) throw new Error('Request missing');
    expect(result.request.requestBody).toMatchObject({
      availability: 'present', value: expect.stringContaining('Google'), untrusted: true, truncated: false,
      source: { system: 'jobber', surface: 'request_form', freshness: 'live' },
    });
    expect(result.request.formSections[0].answers[0].value).toBe('Google');
    expect(result.request.notes).toEqual([]);
    expect(result.request.contextComplete).toBe(true);
  });

  it('preserves valid request metadata when the form session is unavailable', async () => {
    vi.spyOn(JobberWebSession.prototype, 'fetchRequestFormData').mockResolvedValue({ sessionExpired: true, formData: null });
    const read = new OpsAssistantRead({ graphqlRequest: vi.fn().mockResolvedValue({ request: { id: 'req-1', title: 'Bath' } }) }, createMockD1() as never);
    const result = await read.readRequest('user-a', { requestId: 'req-1' });
    expect(result.outcome).toBe('ok');
    expect(result.request?.requestBody).toMatchObject({ availability: 'unavailable', reason: 'jobber_web_session_unavailable' });
    expect(result.request?.contextComplete).toBe(false);
    expect(result.request?.title).toMatchObject({ value: 'Bath' });
  });

  it('does not expose upstream credentials/errors or interpret failures as empty answers', async () => {
    vi.spyOn(JobberWebSession.prototype, 'fetchRequestFormData').mockRejectedValue(new Error('Cookie: secret'));
    const context = await readAssistantRequestContext(createMockD1() as never, 'req-1');
    expect(context.requestBody).toMatchObject({ availability: 'unavailable', reason: 'request_form_read_failed' });
    expect(JSON.stringify(context)).not.toContain('secret');
    expect(context.contextComplete).toBe(false);
  });

  it('marks a partial form as incomplete', async () => {
    vi.spyOn(JobberWebSession.prototype, 'fetchRequestFormData').mockResolvedValue({
      sessionExpired: false, formData: { text: 'Scope: Bath', sections: [], truncated: true },
    });
    const context = await readAssistantRequestContext(createMockD1() as never, 'req-1');
    expect(context.requestBody).toMatchObject({ availability: 'present', truncated: true });
    expect(context.contextComplete).toBe(false);
  });

  it('keeps the first/last form sections and their labeled referral answers', async () => {
    const db = createMockD1();
    configurePrepareResults(db, [{ first: { cookies: 'private-cookie', expires_at: '2099-01-01' } }]);
    const sections = [0, 999].map(sortOrder => ({
      label: 'Request', sortOrder, items: { pageInfo: { hasNextPage: false }, nodes: [
        { label: 'Referral source', reportableAnswer: { value: sortOrder === 0 ? 'Google' : 'Other detail' } },
      ] },
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { request: { requestDetails: { form: { sections: { nodes: sections, pageInfo: { hasNextPage: false } } } } } },
    }), { status: 200 })));
    const context = await readAssistantRequestContext(db as never, 'req-1');
    expect(context.requestBody).toMatchObject({ availability: 'present', truncated: false });
    expect(context.formSections).toHaveLength(2);
    expect(JSON.stringify(context)).toContain('Google');
    expect(JSON.stringify(context)).not.toContain('private-cookie');
  });
});
