import { describe, it, expect } from 'vitest';
import { isPermanentError } from '../../worker/src/queue/image-consumer.js';

describe('isPermanentError (image generation retry classification)', () => {
  it('treats missing/invalid OpenAI config as permanent', () => {
    expect(isPermanentError(new Error('OpenAI API key is not configured.'))).toBe(true);
    expect(isPermanentError(new Error('Invalid API key provided'))).toBe(true);
    expect(isPermanentError(new Error('Unauthorized'))).toBe(true);
  });

  it('treats quota / billing exhaustion as permanent', () => {
    expect(isPermanentError(new Error('You exceeded your current quota'))).toBe(true);
    expect(isPermanentError(new Error('insufficient_quota'))).toBe(true);
    expect(isPermanentError(new Error('billing hard limit reached'))).toBe(true);
  });

  it('treats org-verification and content-policy failures as permanent', () => {
    expect(isPermanentError(new Error('Your organization must be verified to use gpt-image-1'))).toBe(true);
    expect(isPermanentError(new Error('This request was rejected by the content policy'))).toBe(true);
  });

  it('treats embedded 4xx status codes as permanent', () => {
    expect(isPermanentError(new Error('GPT-Image-1 API error (400): bad request'))).toBe(true);
    expect(isPermanentError(new Error('GPT-Image-1 API error (401): bad token'))).toBe(true);
    expect(isPermanentError(new Error('GPT-Image-1 API error (403): org not verified'))).toBe(true);
    expect(isPermanentError(new Error('GPT-Image-1 API error (404): no model'))).toBe(true);
  });

  it('treats transient failures as retryable', () => {
    expect(isPermanentError(new Error('Image generation timed out after 120 seconds'))).toBe(false);
    expect(isPermanentError(new Error('network connection reset'))).toBe(false);
    expect(isPermanentError(new Error('No images were returned from GPT-Image-1.'))).toBe(false);
    // Pure rate-limit (429) without quota wording should be retried
    expect(isPermanentError(new Error('Too many requests (429)'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isPermanentError('some string')).toBe(false);
    expect(isPermanentError(null)).toBe(false);
    expect(isPermanentError(undefined)).toBe(false);
    expect(isPermanentError({ message: 'invalid' })).toBe(false);
  });
});
