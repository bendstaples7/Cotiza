import { describe, it, expect } from 'vitest';
import { emptyToNull, emptyToNullOptional } from '../../worker/src/http/normalize.js';

describe('emptyToNull', () => {
  it('returns null for empty, whitespace, and non-string inputs', () => {
    expect(emptyToNull('')).toBeNull();
    expect(emptyToNull('   ')).toBeNull();
    expect(emptyToNull(undefined)).toBeNull();
    expect(emptyToNull(null)).toBeNull();
    expect(emptyToNull(123)).toBeNull();
  });

  it('trims and returns non-empty strings', () => {
    expect(emptyToNull('chan-1')).toBe('chan-1');
    expect(emptyToNull('  chan-1  ')).toBe('chan-1');
  });
});

describe('emptyToNullOptional', () => {
  it('preserves undefined so PUT/PATCH can leave the field unchanged', () => {
    expect(emptyToNullOptional(undefined)).toBeUndefined();
  });

  it('maps empty/whitespace/null to null (explicit clear)', () => {
    expect(emptyToNullOptional('')).toBeNull();
    expect(emptyToNullOptional('   ')).toBeNull();
    expect(emptyToNullOptional(null)).toBeNull();
  });

  it('trims and returns non-empty strings', () => {
    expect(emptyToNullOptional(' chan-9 ')).toBe('chan-9');
  });
});
