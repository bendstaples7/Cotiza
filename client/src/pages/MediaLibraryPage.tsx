import { useState, useEffect, useCallback, useRef } from 'react';
import type { MediaItem, GeneratedImage, ImageStyle, ErrorResponse } from 'shared';
import { listMedia, uploadMedia, generateImages, saveGeneratedImage, deleteMedia } from '../api';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'video/mp4'];
const ACCEPTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.mp4'];
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const STYLES: { value: ImageStyle; label: string }[] = [
  { value: 'photorealistic', label: 'Photorealistic' },
  { value: 'modern', label: 'Modern' },
  { value: 'illustrative', label: 'Illustrative' },
];

function validateFile(file: File): string | null {
  // Allow empty or generic MIME types through — server-side inferMimeType will resolve from filename
  if (file.type && file.type !== 'application/octet-stream' && !ACCEPTED_TYPES.includes(file.type)) {
    return 'Unsupported format. Please use JPEG, PNG, WebP, HEIC, HEIF, or MP4.';
  }
  if (file.size > MAX_FILE_SIZE) {
    return 'File exceeds the 50 MB size limit.';
  }
  return null;
}

export default function MediaLibraryPage() {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Upload state
  const [showUpload, setShowUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // AI generation state
  const [showGenerate, setShowGenerate] = useState(false);
  const [genDescription, setGenDescription] = useState('');
  const [genStyle, setGenStyle] = useState<ImageStyle | ''>('');
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [generatedImages, setGeneratedImages] = useState<GeneratedImage[]>([]);
  const [savingIndex, setSavingIndex] = useState<number | null>(null);

  // Delete state
  const [deleteTarget, setDeleteTarget] = useState<MediaItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchMedia = useCallback(async () => {
    try {
      setLoading(true);
      const data = await listMedia(1, 100);
      setItems(data.items);
      setError(null);
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Failed to load media.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchMedia(); }, [fetchMedia]);

  // ── Upload handlers ──
  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    const validationError = validateFile(file);
    if (validationError) { setUploadError(validationError); return; }
    try {
      setUploading(true);
      setUploadError(null);
      const item = await uploadMedia(file);
      setItems((prev) => [item, ...prev]);
      setShowUpload(false);
    } catch (err) {
      setUploadError((err as ErrorResponse).message ?? 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  };

  // ── AI generation handlers ──
  const handleGenerate = async () => {
    if (!genDescription.trim()) return;
    try {
      setGenerating(true);
      setGenError(null);
      setGeneratedImages([]);
      const data = await generateImages(genDescription.trim(), genStyle || undefined);
      setGeneratedImages(data.images);
    } catch (err) {
      setGenError((err as ErrorResponse).message ?? 'Image generation failed.');
    } finally {
      setGenerating(false);
    }
  };

  const handleSaveGenerated = async (image: GeneratedImage, index: number) => {
    try {
      setSavingIndex(index);
      const item = await saveGeneratedImage(image);
      setItems((prev) => [item, ...prev]);
      setGeneratedImages((prev) => prev.filter((_, i) => i !== index));
    } catch (err) {
      setGenError((err as ErrorResponse).message ?? 'Failed to save image.');
    } finally {
      setSavingIndex(null);
    }
  };

  // ── Delete handler ──
  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      setDeleting(true);
      await deleteMedia(deleteTarget.id);
      setItems((prev) => prev.filter((i) => i.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Delete failed.');
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  // ── Render ──
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0 }}>Media Library</h1>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={() => { setShowUpload(true); setUploadError(null); }} style={btnStyle}>Upload</button>
          <button onClick={() => { setShowGenerate(true); setGenError(null); setGeneratedImages([]); setGenDescription(''); setGenStyle(''); }} style={btnStyle}>Generate Image</button>
        </div>
      </div>

      {error && <div role="alert" style={alertStyle}>{error}</div>}

      {loading ? (
        <p>Loading media…</p>
      ) : items.length === 0 ? (
        <p style={{ color: '#888' }}>No media yet. Upload files or generate images to get started.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '1rem' }}>
          {items.map((item) => (
            <div key={item.id} style={cardStyle}>
              <div style={{ position: 'relative', paddingTop: '100%', background: '#e0e0e0', borderRadius: '6px 6px 0 0', overflow: 'hidden' }}>
                {item.mimeType.startsWith('video/') ? (
                  <video src={item.thumbnailUrl} style={thumbStyle} />
                ) : (
                  <img src={item.thumbnailUrl} alt={item.filename} style={thumbStyle} loading="lazy" />
                )}
                {item.source === 'ai_generated' && (
                  <span style={badgeStyle} aria-label="AI-Generated">AI</span>
                )}
              </div>
              <div style={{ padding: '0.5rem', fontSize: '0.8rem' }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.filename}>{item.filename}</div>
                <div style={{ color: '#888', marginTop: '0.25rem' }}>{item.source === 'ai_generated' ? 'AI-Generated' : 'Uploaded'}</div>
              </div>
              <button
                onClick={() => setDeleteTarget(item)}
                style={{ ...btnSmall, color: '#d32f2f', borderColor: '#d32f2f', margin: '0 0.5rem 0.5rem' }}
                aria-label={`Delete ${item.filename}`}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Upload Dialog ── */}
      {showUpload && (
        <div style={overlayStyle} onClick={() => !uploading && setShowUpload(false)}>
          <div style={dialogStyle} role="dialog" aria-label="Upload media" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>Upload Media</h2>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              style={{ ...dropZoneStyle, borderColor: dragOver ? '#00a89d' : '#bbb', background: dragOver ? '#e0f7f5' : '#fafafa' }}
            >
              <p style={{ margin: 0, color: '#666' }}>Drag and drop a file here, or</p>
              <button onClick={() => fileInputRef.current?.click()} style={{ ...btnStyle, marginTop: '0.75rem' }} disabled={uploading}>
                Browse Files
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept={[...ACCEPTED_TYPES, ...ACCEPTED_EXTENSIONS].join(',')}
                style={{ display: 'none' }}
                onChange={(e) => handleFiles(e.target.files)}
              />
              <p style={{ margin: '0.75rem 0 0', fontSize: '0.8rem', color: '#999' }}>JPEG, PNG, WebP, HEIC, HEIF, or MP4 — max 50 MB</p>
            </div>
            {uploading && <p style={{ color: '#00a89d' }}>Uploading…</p>}
            {uploadError && <div role="alert" style={{ ...alertStyle, marginTop: '0.75rem' }}>{uploadError}</div>}
            <div style={{ textAlign: 'right', marginTop: '1rem' }}>
              <button onClick={() => setShowUpload(false)} disabled={uploading} style={btnSmall}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── AI Image Generation Dialog ── */}
      {showGenerate && (
        <div style={overlayStyle} onClick={() => !generating && setShowGenerate(false)}>
          <div style={{ ...dialogStyle, maxWidth: 560 }} role="dialog" aria-label="Generate AI image" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>Generate AI Image</h2>
            <label style={labelStyle}>
              Description
              <textarea
                value={genDescription}
                onChange={(e) => setGenDescription(e.target.value)}
                placeholder="e.g., Modern kitchen remodel with white marble countertops"
                rows={3}
                style={inputStyle}
                disabled={generating}
              />
            </label>
            <label style={labelStyle}>
              Style (optional)
              <select value={genStyle} onChange={(e) => setGenStyle(e.target.value as ImageStyle | '')} style={inputStyle} disabled={generating}>
                <option value="">Default</option>
                {STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
            <button onClick={handleGenerate} disabled={generating || !genDescription.trim()} style={{ ...btnStyle, marginTop: '0.5rem' }}>
              {generating ? 'Generating…' : 'Generate'}
            </button>
            {generating && <p style={{ color: '#00a89d', marginTop: '0.5rem' }}>Generating images — this may take up to 30 seconds…</p>}
            {genError && <div role="alert" style={{ ...alertStyle, marginTop: '0.75rem' }}>{genError}</div>}

            {generatedImages.length > 0 && (
              <div style={{ marginTop: '1rem' }}>
                <h3>Generated Images</h3>
                <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                  {generatedImages.map((img, idx) => (
                    <div key={idx} style={{ border: '1px solid #ddd', borderRadius: 6, overflow: 'hidden', width: 150 }}>
                      <img src={img.url} alt={img.description} style={{ width: '100%', height: 150, objectFit: 'cover' }} />
                      <div style={{ padding: '0.4rem', textAlign: 'center' }}>
                        <button
                          onClick={() => handleSaveGenerated(img, idx)}
                          disabled={savingIndex === idx}
                          style={btnSmall}
                        >
                          {savingIndex === idx ? 'Saving…' : 'Save to Library'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ textAlign: 'right', marginTop: '1rem' }}>
              <button onClick={() => setShowGenerate(false)} disabled={generating} style={btnSmall}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Confirmation Dialog ── */}
      {deleteTarget && (
        <div style={overlayStyle} onClick={() => !deleting && setDeleteTarget(null)}>
          <div style={{ ...dialogStyle, maxWidth: 400 }} role="alertdialog" aria-label="Confirm deletion" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>Delete Media</h2>
            <p>Are you sure you want to delete <strong>{deleteTarget.filename}</strong>? This action cannot be undone.</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button onClick={() => setDeleteTarget(null)} disabled={deleting} style={btnSmall}>Cancel</button>
              <button onClick={handleDelete} disabled={deleting} style={{ ...btnSmall, color: '#fff', background: '#d32f2f', borderColor: '#d32f2f' }}>
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ──

const btnStyle: React.CSSProperties = {
  padding: '0.5rem 1rem',
  border: '1px solid #00a89d',
  background: '#00a89d',
  color: '#fff',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: '0.9rem',
};

const btnSmall: React.CSSProperties = {
  padding: '0.3rem 0.75rem',
  border: '1px solid #999',
  background: 'transparent',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: '0.8rem',
};

const cardStyle: React.CSSProperties = {
  background: '#fff',
  borderRadius: 6,
  boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
  overflow: 'hidden',
};

const thumbStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
};

const badgeStyle: React.CSSProperties = {
  position: 'absolute',
  top: 6,
  right: 6,
  background: '#7c4dff',
  color: '#fff',
  fontSize: '0.65rem',
  fontWeight: 700,
  padding: '2px 6px',
  borderRadius: 3,
};

const alertStyle: React.CSSProperties = {
  background: '#fdecea',
  color: '#611a15',
  padding: '0.75rem 1rem',
  borderRadius: 4,
  marginBottom: '1rem',
};

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

const dialogStyle: React.CSSProperties = {
  background: '#fff',
  borderRadius: 8,
  padding: '1.5rem',
  maxWidth: 480,
  width: '90%',
  maxHeight: '85vh',
  overflowY: 'auto',
};

const dropZoneStyle: React.CSSProperties = {
  border: '2px dashed #bbb',
  borderRadius: 8,
  padding: '2rem',
  textAlign: 'center',
  transition: 'border-color 0.2s, background 0.2s',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: '0.75rem',
  fontSize: '0.9rem',
  fontWeight: 500,
};

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: '0.25rem',
  padding: '0.5rem',
  border: '1px solid #ccc',
  borderRadius: 4,
  fontSize: '0.9rem',
  boxSizing: 'border-box',
};
