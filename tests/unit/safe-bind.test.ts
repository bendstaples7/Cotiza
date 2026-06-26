import { describe, it, expect, vi } from 'vitest';
import { safeBind } from '../../worker/src/db/safe-bind.js';

function fakeStmt() {
  const stmt = { bind: vi.fn() } as { bind: ReturnType<typeof vi.fn> };
  stmt.bind.mockReturnValue(stmt);
  return stmt;
}

describe('safeBind', () => {
  it('coerces undefined bind values to null', () => {
    const stmt = fakeStmt();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    safeBind(stmt as unknown as D1PreparedStatement, 'a', undefined, 3, undefined);

    expect(stmt.bind).toHaveBeenCalledWith('a', null, 3, null);
    warn.mockRestore();
  });

  it('passes defined values (including null, 0, "", false) through unchanged', () => {
    const stmt = fakeStmt();

    safeBind(stmt as unknown as D1PreparedStatement, 0, '', null, false);

    expect(stmt.bind).toHaveBeenCalledWith(0, '', null, false);
  });

  it('warns once and names the coerced indexes', () => {
    const stmt = fakeStmt();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    safeBind(stmt as unknown as D1PreparedStatement, undefined, 'x', undefined);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('0, 2');
    warn.mockRestore();
  });

  it('does not warn when there is nothing to coerce', () => {
    const stmt = fakeStmt();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    safeBind(stmt as unknown as D1PreparedStatement, 'a', 'b');

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns the bound statement for chaining', () => {
    const stmt = fakeStmt();
    expect(safeBind(stmt as unknown as D1PreparedStatement, 1)).toBe(stmt);
  });
});
