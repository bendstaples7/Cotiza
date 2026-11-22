import { describe, expect, it } from 'vitest';
import type { AssistantPrincipal } from '../../worker/src/services/assistant-access.js';
import { InvalidAssistantArgs } from '../../worker/src/services/ops-assistant-read.js';
import { ReviewFeedbackStore } from '../../worker/src/services/review-feedback.js';
import { loadQuoteReviews } from '../../worker/src/services/lead-quote-stage.js';
import { createMockD1, configurePrepareResults } from './helpers/mock-d1.js';

const principal: AssistantPrincipal = {
  tokenId: 'tok-write',
  userId: 'user-a',
  clientId: 'claude',
  resource: 'http://127.0.0.1:8787/mcp',
  scope: 'ops:read review:write',
};

describe('record_quote_review summary, edits and artifact link', () => {
  it('saves summary, requested_edits and artifact_url, and loadQuoteReviews reads the text, edits and link back', async () => {
    const record = {
      decision: 'changes_requested',
      summary: 'Scope looks right; the second line needs rework before this goes out.',
      requested_edits: ['Drop the second line', 'Recheck the total against the walkthrough'],
      artifact_url: 'https://claude.ai/artifact/abc',
    };
    const db = createMockD1();
    configurePrepareResults(db, [{ first: { id: 'QR-706-1', created_at: '2026-11-19T12:00:00Z', supersedes: null } }]);
    const saved = await new ReviewFeedbackStore(db as never).recordQuoteReview(principal, {
      author: 'Ben',
      source: 's',
      quoteNumber: '706',
      record,
    }) as { outcome: string };
    expect(saved.outcome).toBe('recorded');

    const storedJson = String(db._stmts[0].bind.mock.calls[0][5]);
    const readDb = createMockD1();
    configurePrepareResults(readDb, [{ all: { results: [{ quote_number: '706', created_at: '2026-11-19T12:00:00Z', record: storedJson }] } }]);
    const reviews = await loadQuoteReviews(readDb as never, ['706']);
    expect(reviews['706']).toMatchObject({
      at: '2026-11-19T12:00:00Z',
      decision: 'changes_requested',
      summary: 'Scope looks right; the second line needs rework before this goes out.',
      requestedEdits: ['Drop the second line', 'Recheck the total against the walkthrough'],
      artifactUrl: 'https://claude.ai/artifact/abc',
    });
  });

  it('rejects a non-https://claude.ai/ artifact_url and stores nothing', async () => {
    const db = createMockD1();
    const store = new ReviewFeedbackStore(db as never);
    await expect(store.recordQuoteReview(principal, {
      author: 'Ben',
      source: 's',
      quoteNumber: '706',
      record: { decision: 'approved', artifact_url: 'https://evil.example/x' },
    })).rejects.toThrow(InvalidAssistantArgs);
    expect(db.prepare).not.toHaveBeenCalled();
  });
});
