import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpsAssistantRead } from '../../worker/src/services/ops-assistant-read.js';
import { downloadRequestPhoto, MAX_PHOTO_BYTES } from '../../worker/src/services/jobber-request-photos.js';
import { handleMcpPost, readMcpJsonBody } from '../../worker/src/routes/ops-assistant.js';
import { CallBudget } from '../../worker/src/services/assistant-access.js';
import { createMockD1 } from './helpers/mock-d1.js';

const signedUrl = 'https://jobber-files.s3.amazonaws.com/tub.jpg?X-Amz-Signature=private';
const jpeg = new Uint8Array([255, 216, 255, 224, 0, 16]);
const photo = { fileName: 'tub.jpg', contentType: 'image/jpeg', url: signedUrl };
function client() {
  return { graphqlRequest: vi.fn().mockResolvedValue({ request: {
    id: 'req-697', noteAttachments: { edges: [{ node: photo }], pageInfo: { hasNextPage: true, endCursor: 'next-page' } },
  } }) };
}
afterEach(() => vi.unstubAllGlobals());

describe('assistant request photos', () => {
  it('returns an image plus safe page metadata through the authenticated MCP transport', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }));
    vi.stubGlobal('fetch', fetcher);
    const jobber = client();
    const db = createMockD1();
    const request = new Request('https://cotiza.example/mcp', {
      method: 'POST', headers: { authorization: 'Bearer assistant-token', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'read_request_photo', arguments: { requestId: 'req-697', cursor: 'prior-page' },
      } }),
    });
    const response = await handleMcpPost(request, {
      directory: { authenticateAccessToken: async () => ({ tokenId: 'tok', userId: 'user-a', resource: 'https://cotiza.example/mcp', scope: 'ops:read', clientId: 'chatgpt' }) } as never,
      read: new OpsAssistantRead(jobber, db as never), db: db as never, budget: new CallBudget(),
    });
    const body = readMcpJsonBody(await response.text()) as { result: { content: Array<Record<string, string>>; isError: boolean } };
    expect(body.result.isError).toBe(false);
    expect(body.result.content[1]).toEqual({ type: 'image', mimeType: 'image/jpeg', data: btoa(String.fromCharCode(...jpeg)) });
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({ requestId: 'req-697', attachmentIndex: 0, page: { nextCursor: 'next-page' } });
    expect(JSON.stringify(body)).not.toContain('X-Amz');
    expect(JSON.stringify(db.prepare.mock.calls)).not.toContain('X-Amz');
    expect(jobber.graphqlRequest.mock.calls[0][1]).toEqual({ id: 'req-697', after: 'prior-page' });
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('headers');
  });

  it('rejects URL injection and invalid indices before fetching Jobber', async () => {
    const jobber = client();
    const read = new OpsAssistantRead(jobber, createMockD1() as never);
    await expect(read.readRequestPhoto('u', { requestId: 'req-697', url: signedUrl })).rejects.toThrow('Unknown field');
    await expect(read.readRequestPhoto('u', { requestId: 'req-697', attachmentIndex: -1 })).rejects.toThrow('attachmentIndex');
    expect(jobber.graphqlRequest).not.toHaveBeenCalled();
  });

  it('does not fetch unapproved hosts or redirect targets', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const url of ['http://127.0.0.1/x', 'https://169.254.169.254/x', 'https://evil.example/x', 'https://getjobber.com.evil.example/x']) {
      await expect(downloadRequestPhoto({ ...photo, url })).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRejectedValue(new Error(`redirect failed ${signedUrl}`));
    const result = await new OpsAssistantRead(client(), createMockD1() as never).readRequestPhoto('u', { requestId: 'req-697' });
    expect(result.outcome).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('X-Amz');
  });

  it('rejects oversized streams, non-images and mismatched image bytes', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    fetcher.mockResolvedValueOnce(new Response(new Uint8Array(MAX_PHOTO_BYTES + 1), { headers: { 'content-type': 'image/jpeg' } }));
    await expect(downloadRequestPhoto(photo)).rejects.toThrow('photo_too_large');
    fetcher.mockResolvedValueOnce(new Response('html', { headers: { 'content-type': 'text/html' } }));
    await expect(downloadRequestPhoto(photo)).rejects.toThrow('unsupported_photo_type');
    fetcher.mockResolvedValueOnce(new Response('html', { headers: { 'content-type': 'image/jpeg' } }));
    await expect(downloadRequestPhoto(photo)).rejects.toThrow('invalid_photo_bytes');
  });

  it('distinguishes a missing request, empty attachment page and failed lookup', async () => {
    const jobber = client();
    const read = new OpsAssistantRead(jobber, createMockD1() as never);
    jobber.graphqlRequest.mockResolvedValueOnce({ request: null });
    expect((await read.readRequestPhoto('u', { requestId: 'req-697' })).outcome).toBe('not_found');
    jobber.graphqlRequest.mockResolvedValueOnce({ request: { id: 'req-697', noteAttachments: { edges: [] } } });
    expect(await read.readRequestPhoto('u', { requestId: 'req-697' })).toMatchObject({ outcome: 'not_found', attachments: [] });
    jobber.graphqlRequest.mockRejectedValueOnce(new Error('timed out'));
    expect(await read.readRequestPhoto('u', { requestId: 'req-697' })).toMatchObject({ outcome: 'failed', read: { liveLookupFailed: true } });
  });
});
