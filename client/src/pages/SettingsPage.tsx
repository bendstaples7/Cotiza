import { useState, useEffect, useCallback } from 'react';
import { AdvisorMode } from 'shared';
import type { UserSettings, ChannelConnection, ErrorResponse } from 'shared';
import {
  fetchSettings, updateSettings, fetchChannels,
  connectInstagram, disconnectChannel, refreshInstagramToken,
  syncInstagramPosts,
} from '../api';
import CorpusStatusIndicator from './CorpusStatusIndicator';

const advisorModes: { value: AdvisorMode; label: string; description: string }[] = [
  { value: AdvisorMode.Smart, label: 'Smart', description: 'Analyzes your post history to recommend the optimal content type' },
  { value: AdvisorMode.Random, label: 'Random', description: 'Randomly suggests content types, weighted toward less-used types' },
  { value: AdvisorMode.Manual, label: 'Manual', description: 'No suggestions — you choose the content type yourself' },
];

export default function SettingsPage() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [channels, setChannels] = useState<ChannelConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ synced: number; skipped: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const [settingsRes, channelsRes] = await Promise.all([fetchSettings(), fetchChannels()]);
      setSettings(settingsRes.settings);
      setChannels(channelsRes.channels);
    } catch {
      // handled by global error display
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdvisorChange = async (mode: AdvisorMode) => {
    setSaving(true);
    try {
      const res = await updateSettings({ advisorMode: mode });
      setSettings(res.settings);
    } catch {
      // handled by global error display
    } finally {
      setSaving(false);
    }
  };

  const handleConnect = async () => {
    setChannelError(null);
    try {
      const result = await connectInstagram();

      // Direct token mode: server connected directly, no popup needed
      if ('connected' in result && (result as Record<string, unknown>).connected) {
        await fetchChannels().then((res) => setChannels(res.channels));
        return;
      }

      const { authorizationUrl } = result;

      // Open OAuth flow in a popup window instead of navigating away
      const width = 500;
      const height = 650;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;
      const popup = window.open(
        authorizationUrl,
        'instagram-oauth',
        `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no`,
      );

      // Poll for popup close (OAuth callback will close it)
      const pollTimer = setInterval(() => {
        if (!popup || popup.closed) {
          clearInterval(pollTimer);
          fetchChannels()
            .then((res) => setChannels(res.channels))
            .catch(() => {});
        }
      }, 500);
    } catch (err) {
      const e = err as ErrorResponse;
      setChannelError(e.message || 'Failed to connect Instagram. Please try again.');
    }
  };

  const handleDisconnect = async (id: string) => {
    if (!confirm('Are you sure you want to disconnect this Instagram account?')) return;
    setDisconnecting(id);
    setChannelError(null);
    try {
      await disconnectChannel(id);
      setChannels((prev) => prev.filter((c) => c.id !== id));
    } catch (err) {
      const e = err as ErrorResponse;
      setChannelError(e.message || 'Failed to disconnect channel. Please try again.');
    } finally {
      setDisconnecting(null);
    }
  };

  const handleRefresh = async (id: string) => {
    setRefreshing(id);
    setChannelError(null);
    try {
      const result = await refreshInstagramToken(id);
      setChannels((prev) => prev.map((c) => c.id === id ? result.channel : c));
    } catch (err) {
      const e = err as ErrorResponse;
      setChannelError(e.message || 'Token refresh failed.');
      // Refetch channels to sync any server-side status changes (e.g., token marked expired)
      try {
        const res = await fetchChannels();
        setChannels(res.channels);
      } catch { /* best-effort */ }
    } finally {
      setRefreshing(null);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setChannelError(null);
    setSyncResult(null);
    try {
      const result = await syncInstagramPosts();
      setSyncResult({ synced: result.synced, skipped: result.skipped });

      // Refetch channels and posts to update the dashboard
      const [postsRes, channelsRes] = await Promise.all([
        fetchPosts(),
        fetchChannels(),
      ]);
      setChannels(channelsRes.channels); // Update channels in SettingsPage state
      // Note: SocialSummary will also refetch on its own if it's mounted and its dependency changes

      if (result.errors.length > 0) {
        setChannelError('Some posts failed to sync: ' + result.errors[0]);
      }
    } catch (err) {
      const e = err as ErrorResponse;
      setChannelError(e.message || 'Instagram sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  if (loading) return <p>Loading settings…</p>;

  const instagramChannels = channels.filter((c) => c.channelType === 'instagram');

  return (
    <div style={{ maxWidth: 700 }}>
      <h1>Settings</h1>

      {/* Content Advisor Mode */}
      <section style={{ marginBottom: '2rem', background: '#fff', borderRadius: 8, padding: '1.25rem', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
        <h2 style={{ margin: '0 0 0.75rem', fontSize: '1.1rem' }}>Content Advisor Mode</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {advisorModes.map((m) => (
            <label
              key={m.value}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: '0.5rem',
                padding: '0.75rem', borderRadius: 6, cursor: 'pointer',
                border: settings?.advisorMode === m.value ? '2px solid #00a89d' : '2px solid #e0e0e0',
                background: settings?.advisorMode === m.value ? 'rgba(79,195,247,0.05)' : 'transparent',
                opacity: saving ? 0.6 : 1,
              }}
            >
              <input
                type="radio"
                name="advisorMode"
                value={m.value}
                checked={settings?.advisorMode === m.value}
                onChange={() => handleAdvisorChange(m.value)}
                disabled={saving}
                style={{ marginTop: 3 }}
              />
              <div>
                <div style={{ fontWeight: 600 }}>{m.label}</div>
                <div style={{ fontSize: '0.85rem', color: '#666' }}>{m.description}</div>
              </div>
            </label>
          ))}
        </div>
      </section>

      {/* Publish Approval Mode */}
      <section style={{ marginBottom: '2rem', background: '#fff', borderRadius: 8, padding: '1.25rem', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
        <h2 style={{ margin: '0 0 0.75rem', fontSize: '1.1rem' }}>Publish Approval</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <div style={{ padding: '0.75rem', borderRadius: 6, border: '2px solid #00a89d', background: 'rgba(79,195,247,0.05)' }}>
            <div style={{ fontWeight: 600 }}>Manual Review</div>
            <div style={{ fontSize: '0.85rem', color: '#666' }}>Every post requires your approval before publishing</div>
            <span style={{ display: 'inline-block', marginTop: 4, fontSize: '0.75rem', background: '#00a89d', color: '#fff', padding: '2px 8px', borderRadius: 10 }}>Active</span>
          </div>
          <div style={{ padding: '0.75rem', borderRadius: 6, border: '2px solid #e0e0e0', opacity: 0.5 }}>
            <div style={{ fontWeight: 600 }}>Auto Publish</div>
            <div style={{ fontSize: '0.85rem', color: '#666' }}>Posts are published automatically after generation</div>
            <span style={{ display: 'inline-block', marginTop: 4, fontSize: '0.75rem', background: '#999', color: '#fff', padding: '2px 8px', borderRadius: 10 }}>Coming Soon</span>
          </div>
        </div>
      </section>

      {/* Quote Corpus Status */}
      <section style={{ marginBottom: '2rem' }}>
        <CorpusStatusIndicator />
      </section>

      {/* Instagram Channel Connection */}
      <section style={{ background: '#fff', borderRadius: 8, padding: '1.25rem', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
        <h2 style={{ margin: '0 0 0.75rem', fontSize: '1.1rem' }}>Instagram Connection</h2>
        {channelError && (
          <div role="alert" style={{ padding: '0.75rem', marginBottom: '0.75rem', background: '#fdecea', color: '#b71c1c', borderRadius: 6, fontSize: '0.9rem' }}>
            {channelError}
          </div>
        )}
        {instagramChannels.length === 0 ? (
          <div>
            <p style={{ color: '#666', margin: '0 0 0.75rem' }}>No Instagram account connected.</p>
            <button
              onClick={handleConnect}
              style={{ background: '#e1306c', color: '#fff', border: 'none', padding: '0.6rem 1.25rem', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}
            >
              Connect Instagram
            </button>
          </div>
        ) : (
          instagramChannels.map((ch) => (
            <div key={ch.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem', border: '1px solid #e0e0e0', borderRadius: 6 }}>
              <div>
                <div style={{ fontWeight: 600 }}>{ch.externalAccountName || 'Instagram Account'}</div>
                <div style={{ fontSize: '0.85rem', color: '#666' }}>
                  Status: <span style={{ color: ch.status === 'connected' ? '#00a89d' : '#b71c1c' }}>{ch.status}</span>
                </div>
                {ch.status === 'expired' && (
                  <div style={{ fontSize: '0.8rem', color: '#e65100', marginTop: 4 }}>
                    Your Instagram token has expired. Please reconnect your account.
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {ch.status === 'connected' && (
                  <button
                    onClick={() => handleRefresh(ch.id)}
                    disabled={refreshing === ch.id}
                    style={{ background: '#fff', color: '#00a89d', border: '1px solid #00a89d', padding: '0.4rem 1rem', borderRadius: 6, cursor: 'pointer' }}
                  >
                    {refreshing === ch.id ? 'Refreshing…' : 'Refresh Token'}
                  </button>
                )}
                {ch.status === 'connected' && (
                  <button
                    onClick={handleSync}
                    disabled={syncing}
                    style={{ background: '#fff', color: '#1976d2', border: '1px solid #1976d2', padding: '0.4rem 1rem', borderRadius: 6, cursor: 'pointer' }}
                  >
                    {syncing ? 'Syncing…' : '🔄 Sync Posts'}
                  </button>
                )}
                {ch.status === 'expired' && (
                  <button
                    onClick={handleConnect}
                    style={{ background: '#e1306c', color: '#fff', border: 'none', padding: '0.4rem 1rem', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}
                  >
                    Reconnect
                  </button>
                )}
                <button
                  onClick={() => handleDisconnect(ch.id)}
                  disabled={disconnecting === ch.id}
                  style={{ background: '#fff', color: '#b71c1c', border: '1px solid #b71c1c', padding: '0.4rem 1rem', borderRadius: 6, cursor: 'pointer' }}
                >
                  {disconnecting === ch.id ? 'Disconnecting…' : 'Disconnect'}
                </button>
              </div>
            </div>
          ))
        )}
        {syncResult && (
          <div style={{ marginTop: '0.75rem', padding: '0.6rem 0.75rem', background: '#e8f5e9', color: '#2e7d32', borderRadius: 6, fontSize: '0.85rem' }}>
            Synced {syncResult.synced} new post{syncResult.synced !== 1 ? 's' : ''} from Instagram.
            {syncResult.skipped > 0 && ` ${syncResult.skipped} already in database.`}
          </div>
        )}
      </section>
    </div>
  );
}
