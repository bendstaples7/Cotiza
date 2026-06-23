import { describe, it, expect } from 'vitest';
import { isActiveJobberQuoteStatus } from '../../worker/src/services/jobber-quote-status.js';

describe('isActiveJobberQuoteStatus', () => {
  it('returns true for in-progress statuses', () => {
    expect(isActiveJobberQuoteStatus('draft')).toBe(true);
    expect(isActiveJobberQuoteStatus('sent')).toBe(true);
    expect(isActiveJobberQuoteStatus('awaiting_response')).toBe(true);
    expect(isActiveJobberQuoteStatus('changes_requested')).toBe(true);
    expect(isActiveJobberQuoteStatus('DRAFT')).toBe(true);
  });

  it('returns false for terminal statuses', () => {
    expect(isActiveJobberQuoteStatus('approved')).toBe(false);
    expect(isActiveJobberQuoteStatus('converted')).toBe(false);
    expect(isActiveJobberQuoteStatus('archived')).toBe(false);
  });
});
