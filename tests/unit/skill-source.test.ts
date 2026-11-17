import { describe, expect, it, vi } from 'vitest';
import { SkillArgsError, SkillSource, SKILL_SOURCE_LIMITS, parseSkillArgs } from '../../worker/src/services/skill-source.js';

const TREE = {
  tree: [
    { path: 'skills/chicago-reno-review-quotes/SKILL.md', type: 'blob', size: 10 },
    { path: 'skills/chicago-reno-review-quotes/feedback.json', type: 'blob', size: 10 },
    { path: 'skills/chicago-reno-review-quotes/review-page/template.html', type: 'blob', size: 10 },
    { path: 'skills/chicago-reno-review-quotes/review-page', type: 'tree' },
    { path: 'skills/prepare-strength-workout/SKILL.md', type: 'blob', size: 10 },
    { path: 'skills/prepare-strength-workout/secrets', type: 'blob', mode: '120000', size: 10 },
    { path: 'skills/big/SKILL.md', type: 'blob', size: 3_000_000 },
    { path: 'README.md', type: 'blob', size: 10 },
  ],
};

function fakeFetch(files: Record<string, string>, treeStatus = 200) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/git/trees/')) {
      return new Response(JSON.stringify(TREE), { status: treeStatus });
    }
    const path = decodeURIComponent(url.split('/contents/')[1]!.split('?')[0]!);
    return path in files ? new Response(files[path]) : new Response('missing', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('read_skill', () => {
  it('lists skill names', async () => {
    const src = new SkillSource({ token: 't', repo: 'o/r', fetchImpl: fakeFetch({}) });
    const res = await src.read({});
    expect(res).toMatchObject({ outcome: 'ok', skills: ['big', 'chicago-reno-review-quotes', 'prepare-strength-workout'] });
  });

  it('returns SKILL.md with the file list', async () => {
    const src = new SkillSource({ token: 't', repo: 'o/r', fetchImpl: fakeFetch({ 'skills/chicago-reno-review-quotes/SKILL.md': '# Quote reviews' }) });
    const res = await src.read({ name: 'chicago-reno-review-quotes' });
    expect(res).toMatchObject({
      outcome: 'ok',
      file: 'SKILL.md',
      content: '# Quote reviews',
      nextOffset: null,
      files: ['SKILL.md', 'feedback.json', 'review-page/template.html'],
    });
  });

  it('pages long files', async () => {
    const long = 'x'.repeat(SKILL_SOURCE_LIMITS.pageChars + 5);
    const src = new SkillSource({ token: 't', repo: 'o/r', fetchImpl: fakeFetch({ 'skills/chicago-reno-review-quotes/feedback.json': long }) });
    const first = await src.read({ name: 'chicago-reno-review-quotes', file: 'feedback.json' }) as { nextOffset: number; content: string };
    expect(first.content).toHaveLength(SKILL_SOURCE_LIMITS.pageChars);
    expect(first.nextOffset).toBe(SKILL_SOURCE_LIMITS.pageChars);
    const second = await src.read({ name: 'chicago-reno-review-quotes', file: 'feedback.json', offset: first.nextOffset }) as { nextOffset: number | null; content: string };
    expect(second.content).toBe('xxxxx');
    expect(second.nextOffset).toBeNull();
  });

  it('says not_found for an unknown skill or file', async () => {
    const src = new SkillSource({ token: 't', repo: 'o/r', fetchImpl: fakeFetch({}) });
    expect(await src.read({ name: 'nope' })).toMatchObject({ outcome: 'not_found' });
    expect(await src.read({ name: 'chicago-reno-review-quotes', file: 'x.md' })).toMatchObject({ outcome: 'not_found', files: expect.any(Array) });
  });

  it('reports a failed read, never an empty list', async () => {
    const src = new SkillSource({ token: 't', repo: 'o/r', fetchImpl: fakeFetch({}, 404) });
    expect(await src.read({})).toMatchObject({ outcome: 'failed', failure: { code: 'github_read_failed' } });
    const none = new SkillSource({ repo: 'o/r', fetchImpl: fakeFetch({}) });
    expect(await none.read({})).toMatchObject({ outcome: 'failed', failure: { code: 'not_configured' } });
  });

  it('skips symlinks, refuses huge files and reports failed file reads', async () => {
    const src = new SkillSource({ token: 't', repo: 'o/r', fetchImpl: fakeFetch({}) });
    expect(await src.read({ name: 'prepare-strength-workout', file: 'secrets' })).toMatchObject({ outcome: 'not_found' });
    expect(await src.read({ name: 'big' })).toMatchObject({ outcome: 'failed', failure: { code: 'too_large' } });
    expect(await src.read({ name: 'prepare-strength-workout' })).toMatchObject({ outcome: 'failed', failure: { code: 'github_read_failed' } });
  });

  it('fails when GitHub truncates the file list', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ...TREE, truncated: true }))) as unknown as typeof fetch;
    const src = new SkillSource({ token: 't', repo: 'o/r', fetchImpl });
    expect(await src.read({})).toMatchObject({ outcome: 'failed', failure: { code: 'github_read_failed' } });
  });

  it('rejects path traversal and bad names', () => {
    expect(() => parseSkillArgs({ name: '../x' })).toThrow(SkillArgsError);
    expect(() => parseSkillArgs({ name: 'a', file: '../../.env' })).toThrow(SkillArgsError);
    expect(() => parseSkillArgs({ file: 'SKILL.md' })).toThrow(SkillArgsError);
    expect(() => parseSkillArgs({ name: 'a', offset: -1 })).toThrow(SkillArgsError);
  });
});
