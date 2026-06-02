import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchPosts, fetchChannels, syncInstagramPosts } from '../api';
import type { Post, ChannelConnection } from 'shared';

interface SocialSummaryProps {
  /** Callback fired when the user clicks the Retry button after a fetch error */
  onRetry?: () => void;
}

/**
 * Shared social-media summary component.
 *
 * Fetches posts/channels (after triggering an Instagram sync) and renders
 * a 5-column metric grid showing total posts, drafts, awaiting review,
 * published, and failed counts. Also shows a channel-status callout when no
 * channels are connected or the token has expired.
 *
 * Props:
 *   onRetry  - optional hook fired after the user clicks Retry (e.g. for analytics)
 */
export default function SocialSummary({ onRetry }: SocialSummaryProps) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [channels, setChannels] = useState<ChannelConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const cancelledRef = useRef(false);

  const loadSocialData = useCallback(async () => {
    cancelledRef.current = false;
    setLoading(true);
    setFetchError(false);

    // Trigger Instagram sync first so fresh data is available before the fetch
    await syncInstagramPosts()
      .catch((err) => {
        console.error('Instagram sync failed:', err);
        // Sync failure is ancillary — don't set fetchError, the main fetch might still succeed
      });

    if (cancelledRef.current) return;

    try {
      const [postsResult, channelsResult] = await Promise.all([
        fetchPosts(),
        fetchChannels(),
      ]);

      if (!cancelledRef.current) {
        setPosts(postsResult.posts);
        setChannels(channelsResult.channels);
      }
    } catch (err) {
      if (!cancelledRef.current) {
        console.error('Failed to fetch social data:', err);
        setFetchError(true);
      }
    } finally {
      if (!cancelledRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    loadSocialData();
    return () => { cancelledRef.current = true; };
  }, [loadSocialData]);

  const drafts = posts.filter((p) => p.status === 'draft');
  const published = posts.filter((p) => p.status === 'published');
  const failed = posts.filter((p) => p.status === 'failed');
  const awaiting = posts.filter((p) => p.status === 'awaiting_approval');
  const connected = channels.filter((c) => c.status === 'connected');

  const handleRetry = () => {
    onRetry?.();
    loadSocialData();
  };

  return (
    <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #e0e0e0', padding: '1.5rem' }}>
      {loading ? (
        <p style={{ color: '#999', textAlign: 'center', padding: '1rem 0' }}>Loading stats...</p>
      ) : fetchError ? (
        <div style={{ background: '#fff0f0', border: '1px solid #ffcccc', borderRadius: 8, padding: '0.75rem 1rem', fontSize: '0.9rem', color: '#cc0000', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
          <span>⚠️ Could not load social media data.</span>
          <button type="button" onClick={handleRetry} style={{ background: '#cc0000', color: '#fff', border: 'none', borderRadius: 4, padding: '0.35rem 0.75rem', cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem', whiteSpace: 'nowrap' }}>
            Retry
          </button>
        </div>
      ) : (
        <>
          {connected.length === 0 && (
            <div style={{ background: '#fff3e0', border: '1px solid #ffe0b2', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.9rem' }}>
              {channels.some((c) => c.status === 'expired') ? '📡 Instagram token expired.' : '📡 No channels connected.'}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '1rem' }}>
            <div style={statBox}>
              <div style={{ fontSize: '1.75rem', fontWeight: 700, color: '#0a1e24' }}>{posts.length}</div>
              <div style={{ fontSize: '0.85rem', color: '#888' }}>Total Posts</div>
            </div>
            <div style={statBox}>
              <div style={{ fontSize: '1.75rem', fontWeight: 700, color: '#ff9800' }}>{drafts.length}</div>
              <div style={{ fontSize: '0.85rem', color: '#888' }}>Drafts</div>
            </div>
            <div style={statBox}>
              <div style={{ fontSize: '1.75rem', fontWeight: 700, color: '#2196f3' }}>{awaiting.length}</div>
              <div style={{ fontSize: '0.85rem', color: '#888' }}>Awaiting Review</div>
            </div>
            <div style={statBox}>
              <div style={{ fontSize: '1.75rem', fontWeight: 700, color: '#4caf50' }}>{published.length}</div>
              <div style={{ fontSize: '0.85rem', color: '#888' }}>Published</div>
            </div>
            <div style={statBox}>
              <div style={{ fontSize: '1.75rem', fontWeight: 700, color: '#f44336' }}>{failed.length}</div>
              <div style={{ fontSize: '0.85rem', color: '#888' }}>Failed</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const statBox: React.CSSProperties = {
  background: '#fff',
  borderRadius: 8,
  padding: '1.25rem',
  boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  textAlign: 'center',
};