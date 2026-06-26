import { describe, it, expect } from 'vitest';
import {
  formatHashtagString,
  buildPublicMediaUrl,
  parseGraphError,
} from '../../worker/src/services/instagram-channel.js';

describe('formatHashtagString', () => {
  it('prefixes bare words with #', () => {
    expect(formatHashtagString(['renovation', 'home'])).toBe('#renovation #home');
  });

  it('does not double-prefix already-hashtagged words', () => {
    expect(formatHashtagString(['#already', 'plain'])).toBe('#already #plain');
    expect(formatHashtagString(['##double'])).toBe('#double');
  });

  it('trims whitespace and drops empty entries', () => {
    expect(formatHashtagString(['  spaced  ', '', '   '])).toBe('#spaced');
  });

  it('returns an empty string when there are no hashtags', () => {
    expect(formatHashtagString([])).toBe('');
  });
});

describe('buildPublicMediaUrl', () => {
  it('joins base and key with a single slash', () => {
    expect(buildPublicMediaUrl('https://pub.r2.dev', 'media/u/p.jpg')).toBe(
      'https://pub.r2.dev/media/u/p.jpg',
    );
  });

  it('strips trailing slashes from the base', () => {
    expect(buildPublicMediaUrl('https://pub.r2.dev/', 'media/u/p.jpg')).toBe(
      'https://pub.r2.dev/media/u/p.jpg',
    );
  });

  it('URL-encodes each path segment but keeps slashes', () => {
    expect(buildPublicMediaUrl('https://pub.r2.dev', 'media/u/my photo (1).jpg')).toBe(
      'https://pub.r2.dev/media/u/my%20photo%20(1).jpg',
    );
  });
});

describe('parseGraphError', () => {
  it('extracts error.message from a Graph JSON body', () => {
    expect(parseGraphError(JSON.stringify({ error: { message: 'Invalid OAuth token' } }))).toBe(
      'Invalid OAuth token',
    );
  });

  it('prefers error_user_msg when present', () => {
    expect(
      parseGraphError(JSON.stringify({ error: { message: 'tech detail', error_user_msg: 'Please reconnect' } })),
    ).toBe('Please reconnect');
  });

  it('falls back to truncated raw text for non-JSON bodies', () => {
    expect(parseGraphError('502 Bad Gateway')).toBe('502 Bad Gateway');
  });

  it('returns a default message for an empty body', () => {
    expect(parseGraphError('')).toBe('Instagram rejected the request.');
  });
});
