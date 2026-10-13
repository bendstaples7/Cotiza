import { useCallback, useEffect, useState } from 'react';
import type { ErrorResponse } from 'shared';
import {
  listAssistantTokens,
  mintAssistantToken,
  opsAssistantMcpUrl,
  revokeAssistantToken,
  type AssistantTokenSummary,
} from '../api';

function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
}

export default function OpsAssistantPage() {
  const [tokens, setTokens] = useState<AssistantTokenSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('local exercise');
  const [minting, setMinting] = useState(false);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const mcpUrl = opsAssistantMcpUrl();

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await listAssistantTokens();
      setTokens(res.tokens.filter((t) => !t.revokedAt));
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Could not load assistant tokens.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <h1 style={{ margin: 0 }}>Operations assistant</h1>
        <span style={{ fontSize: '0.85rem', color: '#666' }}>Read-only · Jobber requests and quotes</span>
      </div>

      <p style={{ color: '#666', lineHeight: 1.5 }}>
        Connect ChatGPT or another MCP client to Cotiza. The assistant never sees Jobber passwords.
        It can only read requests and quotes. Notes and quote messages are untrusted.
      </p>

      <div style={{ background: '#fff', borderRadius: 8, padding: '1rem', marginBottom: '1.25rem', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <strong>MCP server URL</strong>
          <code style={{ fontSize: '0.85rem', wordBreak: 'break-all' }}>{mcpUrl}</code>
        </div>
        <p style={{ margin: '0.75rem 0 0', fontSize: '0.85rem', color: '#666' }}>
          In ChatGPT: add a custom MCP server, pick OAuth, and use this URL. Sign in with your Chicago Reno email.
        </p>
      </div>

      <div style={{ background: '#fff', borderRadius: 8, padding: '1rem', marginBottom: '1.25rem', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
          <strong>Local read token</strong>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label"
              maxLength={80}
              style={{ padding: '0.35rem 0.5rem', border: '1px solid #ccc', borderRadius: 4, fontSize: '0.9rem' }}
            />
            <button
              type="button"
              disabled={minting || !label.trim()}
              onClick={async () => {
                setMinting(true);
                setError(null);
                setFreshToken(null);
                try {
                  const issued = await mintAssistantToken(label.trim());
                  setFreshToken(issued.token);
                  await load();
                } catch (err) {
                  setError((err as ErrorResponse).message ?? 'Could not create token.');
                } finally {
                  setMinting(false);
                }
              }}
              style={{
                background: minting ? '#ccc' : '#00a89d', color: '#fff', border: 'none',
                padding: '0.4rem 0.9rem', borderRadius: 4, cursor: minting ? 'default' : 'pointer', fontWeight: 600,
              }}
            >
              {minting ? 'Creating…' : 'Create token'}
            </button>
          </div>
        </div>
        <p style={{ margin: 0, fontSize: '0.85rem', color: '#666' }}>
          For local scripts only. Copy the token once — it is not shown again. Use{' '}
          <code>OPS_ASSISTANT_TOKEN</code> with <code>scripts/ops-assistant-exercise.mjs</code>.
        </p>
        {freshToken && (
          <textarea
            readOnly
            value={freshToken}
            rows={2}
            style={{ width: '100%', marginTop: '0.75rem', fontFamily: 'monospace', fontSize: '0.8rem', boxSizing: 'border-box' }}
            onFocus={(e) => e.target.select()}
          />
        )}
      </div>

      {error && (
        <p style={{ color: '#b71c1c', marginBottom: '1rem' }} role="alert">{error}</p>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Active tokens</h2>
        <button type="button" onClick={load} disabled={loading} style={{ fontSize: '0.85rem' }}>
          Refresh
        </button>
      </div>

      {loading && tokens.length === 0 ? (
        <p style={{ color: '#666' }}>Loading…</p>
      ) : tokens.length === 0 ? (
        <p style={{ color: '#666' }}>No active read tokens. ChatGPT OAuth tokens also appear here after you connect.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {tokens.map((token) => (
            <li
              key={token.id}
              style={{
                background: '#fff', borderRadius: 8, padding: '0.75rem 1rem',
                boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap',
              }}
            >
              <div>
                <div style={{ fontWeight: 600 }}>{token.label}</div>
                <div style={{ fontSize: '0.8rem', color: '#666' }}>
                  {token.kind} · expires {formatWhen(token.expiresAt)}
                </div>
              </div>
              <button
                type="button"
                disabled={revokingId === token.id}
                onClick={async () => {
                  setRevokingId(token.id);
                  setError(null);
                  try {
                    await revokeAssistantToken(token.id);
                    await load();
                  } catch (err) {
                    setError((err as ErrorResponse).message ?? 'Could not revoke token.');
                  } finally {
                    setRevokingId(null);
                  }
                }}
                style={{
                  background: 'transparent', color: '#b71c1c', border: '1px solid #e0b4b4',
                  padding: '0.35rem 0.75rem', borderRadius: 4, cursor: 'pointer', fontSize: '0.85rem',
                }}
              >
                {revokingId === token.id ? 'Revoking…' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
