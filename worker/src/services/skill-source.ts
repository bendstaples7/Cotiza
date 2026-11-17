/**
 * read_skill: serve Ben's Staple Stack skills (the source of truth for his
 * agent skills) through the connector, so any Claude session can load a skill
 * such as chicago-reno-review-quotes without attaching or cloning the repo.
 *
 * Read-only. Reads the GitHub repo with a token that only needs Contents: read
 * on the Staple Stack repo (STAPLE_STACK_PAT, falling back to GITHUB_PAT).
 */

export const SKILL_SOURCE_LIMITS = {
  /** Characters returned per call; follow nextOffset for the rest. */
  pageChars: 60_000,
  maxFileBytes: 2_000_000,
} as const;

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILLS_DIR = 'skills';

export const SKILL_READ_TOOLS = [
  {
    name: 'read_skill',
    description: 'Read one of Ben\'s Staple Stack skills from GitHub (Staple Stack is the source of truth for his agent skills). With name: the skill\'s SKILL.md plus its file list. With name and file: one file from that skill, e.g. "feedback.json" or "review-page/template.html". Without name: the list of skill names. Long files come in pages: follow nextOffset. Use it to load a skill Ben asks for (e.g. chicago-reno-review-quotes) when the repository is not attached. Read-only. A failed read is not a missing skill.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Skill folder name, e.g. "chicago-reno-review-quotes"' },
        file: { type: 'string', description: 'Path inside the skill folder. Omit for SKILL.md.' },
        offset: { type: 'integer', minimum: 0, description: 'Character offset from a previous nextOffset' },
      },
    },
  },
] as const;

export const SKILL_TOOL_NAMES = new Set<string>(SKILL_READ_TOOLS.map((tool) => tool.name));

export class SkillArgsError extends Error {}

type Fetch = typeof fetch;

export interface SkillSourceOptions {
  token?: string;
  repo: string;
  ref?: string;
  apiBase?: string;
  fetchImpl?: Fetch;
}

interface TreeEntry { path: string; type: string; mode?: string; size?: number }

const FETCH_TIMEOUT_MS = 10_000;

function failed(code: string, message: string) {
  return { outcome: 'failed' as const, failure: { code, message } };
}

export function parseSkillArgs(args: unknown): { name?: string; file?: string; offset: number } {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const name = a.name === undefined ? undefined : String(a.name).trim();
  const file = a.file === undefined ? undefined : String(a.file).trim().replace(/^\/+/, '');
  const offset = a.offset === undefined ? 0 : Number(a.offset);
  if (name !== undefined && !NAME_RE.test(name)) throw new SkillArgsError('name must be a skill folder name like "chicago-reno-review-quotes".');
  if (file !== undefined && (file === '' || file.split('/').some((part) => part === '..' || part === '.' || part === ''))) {
    throw new SkillArgsError('file must be a path inside the skill folder, without "..".');
  }
  if (file !== undefined && name === undefined) throw new SkillArgsError('file needs name.');
  if (!Number.isInteger(offset) || offset < 0) throw new SkillArgsError('offset must be a whole number of 0 or more.');
  return { name, file, offset };
}

export class SkillSource {
  private readonly fetchImpl: Fetch;
  private readonly apiBase: string;
  private readonly ref: string;
  private tree?: Promise<TreeEntry[]>;

  constructor(private readonly opts: SkillSourceOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }));
    this.apiBase = opts.apiBase ?? 'https://api.github.com';
    this.ref = opts.ref ?? 'main';
  }

  private headers(accept: string): HeadersInit {
    return {
      Accept: accept,
      Authorization: `Bearer ${this.opts.token}`,
      'User-Agent': 'cotiza-skill-source',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  private loadTree(): Promise<TreeEntry[]> {
    this.tree ??= (async () => {
      const res = await this.fetchImpl(
        `${this.apiBase}/repos/${this.opts.repo}/git/trees/${encodeURIComponent(this.ref)}?recursive=1`,
        { headers: this.headers('application/vnd.github+json') },
      );
      if (!res.ok) throw new Error(`tree ${res.status}`);
      const body = (await res.json()) as { tree?: TreeEntry[]; truncated?: boolean };
      // A truncated tree would make skills look missing; fail instead of guessing.
      if (body.truncated) throw new Error('tree truncated');
      // Symlinks (mode 120000) are skipped: the Contents API follows them to files outside the skill.
      return (body.tree ?? []).filter((e) => e.path.startsWith(`${SKILLS_DIR}/`) && e.mode !== '120000');
    })();
    return this.tree;
  }

  private source() {
    return { system: 'github', repo: this.opts.repo, ref: this.ref, fetchedAt: new Date().toISOString() };
  }

  async read(args: unknown) {
    const { name, file, offset } = parseSkillArgs(args);
    if (!this.opts.token) {
      return failed('not_configured', 'The connector has no GitHub token for Staple Stack (STAPLE_STACK_PAT). Nothing was read. This is not a missing skill.');
    }
    let tree: TreeEntry[];
    try {
      tree = await this.loadTree();
    } catch (err) {
      const status = String(err).match(/tree (\d+)/)?.[1];
      const why = status ? ` (GitHub ${status})` : /truncated/.test(String(err)) ? ' (file list too long to read in one call)' : '';
      return failed('github_read_failed', `Could not read the Staple Stack repository${why}. Nothing was read. This is not a missing skill.`);
    }

    if (name === undefined) {
      const skills = tree
        .filter((e) => e.type === 'blob' && /^skills\/[^/]+\/SKILL\.md$/.test(e.path))
        .map((e) => e.path.split('/')[1]!)
        .sort();
      return { outcome: 'ok' as const, skills, source: this.source() };
    }

    const prefix = `${SKILLS_DIR}/${name}/`;
    const files = tree.filter((e) => e.type === 'blob' && e.path.startsWith(prefix));
    if (files.length === 0) return { outcome: 'not_found' as const, message: `No skill named "${name}" in Staple Stack.`, source: this.source() };
    const rel = file ?? 'SKILL.md';
    const entry = files.find((e) => e.path === prefix + rel);
    if (!entry) {
      return { outcome: 'not_found' as const, message: `No file "${rel}" in skill "${name}".`, files: files.map((e) => e.path.slice(prefix.length)), source: this.source() };
    }
    if ((entry.size ?? 0) > SKILL_SOURCE_LIMITS.maxFileBytes) {
      return failed('too_large', `"${rel}" is larger than ${SKILL_SOURCE_LIMITS.maxFileBytes} bytes.`);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(
      `${this.apiBase}/repos/${this.opts.repo}/contents/${entry.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(this.ref)}`,
      { headers: this.headers('application/vnd.github.raw') },
      );
    } catch {
      return failed('github_read_failed', `Could not read "${rel}" (GitHub did not answer). Nothing was read.`);
    }
    if (!res.ok) return failed('github_read_failed', `Could not read "${rel}" (GitHub ${res.status}). Nothing was read.`);
    const text = await res.text();
    const end = Math.min(text.length, offset + SKILL_SOURCE_LIMITS.pageChars);
    return {
      outcome: 'ok' as const,
      skill: name,
      file: rel,
      content: text.slice(offset, end),
      offset,
      totalChars: text.length,
      nextOffset: end < text.length ? end : null,
      ...(file === undefined ? { files: files.map((e) => e.path.slice(prefix.length)) } : {}),
      source: this.source(),
    };
  }
}

export async function callSkillTool(source: SkillSource, name: string, args: unknown) {
  if (name === 'read_skill') return source.read(args);
  return null;
}
