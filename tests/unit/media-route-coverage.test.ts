import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PUBLIC_MEDIA_ROUTE_PREFIXES } from '../../shared/src/media-urls.js';

const root = resolve(import.meta.dirname, '../..');

describe('media route coverage (dev proxy + Pages redirects)', () => {
  it('vite dev proxy covers every public media mount', () => {
    const viteConfig = readFileSync(resolve(root, 'client/vite.config.ts'), 'utf8');
    for (const prefix of PUBLIC_MEDIA_ROUTE_PREFIXES) {
      expect(viteConfig).toContain(`'${prefix}'`);
    }
  });

  it('_redirects forwards every public media mount to the worker', () => {
    const redirects = readFileSync(resolve(root, 'client/public/_redirects'), 'utf8');
    for (const prefix of PUBLIC_MEDIA_ROUTE_PREFIXES) {
      const pattern = prefix.replace(/^\//, '') + '/*';
      expect(redirects).toContain(pattern);
      expect(redirects).toContain('social-media-cross-poster.chicago-reno.workers.dev');
    }
  });
});
