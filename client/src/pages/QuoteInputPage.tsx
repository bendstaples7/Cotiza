import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MediaItem, JobberCustomerRequest } from 'shared';
import { uploadMedia, generateQuote, checkJobberStatus, fetchJobberRequestFormData } from '../api';
import RequestSelector from './RequestSelector';
import ManualRequestForm from './ManualRequestForm';
import JobberQuoteImportSection from '../components/JobberQuoteImportSection';

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as any).message === 'string') {
    return (err as any).message;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

const ACCEPTED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
]);
const ACCEPTED_FORMATS_LABEL = 'JPEG, PNG, HEIC, WebP';
const MAX_IMAGES = 10;

/**
 * Build customer text directly from the request object.
 * Single source of truth — no separate API call needed.
 */
function buildCustomerText(request: JobberCustomerRequest): string {
  const parts: string[] = [];

  // Use description if it adds content beyond what's in the notes
  if (request.description) {
    const trimmedDesc = request.description.trim();
    if (trimmedDesc) {
      // Only skip description if it's exactly the notes joined together
      const noteTexts = request.structuredNotes.map((n) => n.message.trim());
      const notesJoined = noteTexts.join('\n\n');
      if (trimmedDesc !== notesJoined) {
        parts.push(trimmedDesc);
      }
    }
  }

  // Add structured notes with author labels
  for (const note of request.structuredNotes) {
    const trimmed = note.message.trim();
    if (!trimmed) continue;
    const label = note.createdBy === 'team' ? '[Team Note]' : note.createdBy === 'client' ? '[Client]' : '[System]';
    parts.push(`${label} ${trimmed}`);
  }

  return parts.join('\n\n') || request.title?.trim() || '';
}

export default function QuoteInputPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [customerText, setCustomerText] = useState('');
  const [images, setImages] = useState<MediaItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [jobberAvailable, setJobberAvailable] = useState(false);
  const [jobberChecked, setJobberChecked] = useState(false);
  const [jobberRequestId, setJobberRequestId] = useState<string | null>(null);
  const [hasLoadedFormData, setHasLoadedFormData] = useState(false);
  const [showManualForm, setShowManualForm] = useState(false);

  useEffect(() => {
    checkJobberStatus()
      .then((available) => setJobberAvailable(available))
      .catch(() => setJobberAvailable(false))
      .finally(() => setJobberChecked(true));
  }, []);

  const selectTokenRef = useRef(0);

  const handleRequestSelect = async (request: JobberCustomerRequest) => {
    const token = ++selectTokenRef.current;
    setJobberRequestId(request.id);

    // Try the form-data endpoint first (uses web session cookies for requestDetails.form)
    try {
      const { formData } = await fetchJobberRequestFormData(request.id);
      if (token !== selectTokenRef.current) return; // stale
      if (formData && formData.text) {
        setCustomerText(formData.text);
        setHasLoadedFormData(true);
        return;
      }
    } catch {
      if (token !== selectTokenRef.current) return;
      // Fall through to local extraction
    }

    if (token !== selectTokenRef.current) return;
    // Fallback: build text from the request object's notes/description
    setCustomerText(buildCustomerText(request));
    setHasLoadedFormData(true);
  };

  const handleRequestClear = () => {
    ++selectTokenRef.current;
    setJobberRequestId(null);
    setCustomerText('');
    setHasLoadedFormData(false);
  };

  const hasText = customerText.trim().length > 0;
  const hasImages = images.length > 0;
  const hasJobberRequest = jobberRequestId !== null;
  const canGenerate = (hasText || hasImages || hasJobberRequest) && !generating;

  const validateAndUploadFiles = useCallback(async (files: FileList | File[]) => {
    setFileError(null);
    const fileArray = Array.from(files);

    // Check for invalid file types first
    for (const file of fileArray) {
      if (!ACCEPTED_MIME_TYPES.has(file.type)) {
        setFileError(
          `"${file.name}" is not an accepted format. Accepted formats: ${ACCEPTED_FORMATS_LABEL}.`
        );
        return;
      }
    }

    // Check image count limit
    if (images.length + fileArray.length > MAX_IMAGES) {
      setFileError(`You can upload a maximum of ${MAX_IMAGES} images.`);
      return;
    }

    // Upload each file
    setUploading(true);
    try {
      const uploaded: MediaItem[] = [];
      for (const file of fileArray) {
        const item = await uploadMedia(file);
        uploaded.push(item);
      }
      setImages((prev) => [...prev, ...uploaded]);
    } catch (err) {
      setFileError(extractErrorMessage(err, 'Upload failed.'));
    } finally {
      setUploading(false);
    }
  }, [images.length]);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      validateAndUploadFiles(e.target.files);
    }
    // Reset so the same file can be re-selected
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      validateAndUploadFiles(e.dataTransfer.files);
    }
  };

  const removeImage = (id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
    setFileError(null);
  };

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setGenerating(true);
    setFileError(null);
    try {
      const draft = await generateQuote({
        customerText: hasText ? customerText.trim() : undefined,
        mediaItemIds: images.length > 0 ? images.map((img) => img.id) : undefined,
        jobberRequestId: jobberRequestId ?? undefined,
      });
      navigate('/quotes/drafts/' + draft.id);
    } catch (err) {
      setFileError(extractErrorMessage(err, 'Quote generation failed.'));
    } finally {
      setGenerating(false);
    }
  };

  // When Jobber is unavailable, show ManualRequestForm as the primary input method
  if (jobberChecked && !jobberAvailable) {
    return (
      <div style={containerStyle}>
        <ManualRequestForm />
      </div>
    );
  }

  // When user has toggled to manual form mode
  if (showManualForm) {
    return (
      <div style={containerStyle}>
        <button
          onClick={() => setShowManualForm(false)}
          style={backBtnStyle}
          type="button"
        >
          ← Back
        </button>
        <ManualRequestForm />
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <h1 style={titleStyle}>New Quote</h1>

      {/* Jobber Request Selector */}
      {jobberAvailable && (
        <RequestSelector
          onSelect={handleRequestSelect}
          onClear={handleRequestClear}
          selectedRequestId={jobberRequestId}
          hasFormData={hasLoadedFormData}
        />
      )}

      {/* Create Manual Request button */}
      {jobberAvailable && (
        <div style={{ marginBottom: '1.25rem' }}>
          <button
            onClick={() => setShowManualForm(true)}
            style={btnOutlineStyle}
            type="button"
          >
            Create Manual Request
          </button>
        </div>
      )}

      {/* Customer request text area */}
      <label style={labelStyle}>
        Customer Request
        <textarea
          value={customerText}
          onChange={(e) => setCustomerText(e.target.value)}
          placeholder={jobberRequestId
            ? 'Request details loaded above. Edit as needed or paste additional details.'
            : 'Paste the customer\'s email, text message, or describe the work requested…'}
          rows={6}
          style={textareaStyle}
          disabled={generating}
          aria-label="Customer request text"
        />
      </label>

      {/* Image upload area */}
      <div style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <span style={{ fontWeight: 500, fontSize: '0.9rem' }}>Reference Images</span>
          <span style={{ fontSize: '0.8rem', color: '#888' }}>{images.length}/{MAX_IMAGES}</span>
        </div>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          style={{
            ...dropZoneStyle,
            borderColor: dragOver ? '#00a89d' : '#bbb',
            background: dragOver ? '#e0f7f5' : '#fafafa',
          }}
        >
          <p style={{ margin: 0, color: '#666' }}>
            Drag and drop images here, or
          </p>
          <button
            onClick={() => fileInputRef.current?.click()}
            style={{ ...btnOutlineStyle, marginTop: '0.75rem' }}
            disabled={uploading || generating}
            type="button"
          >
            Browse Files
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".jpg,.jpeg,.png,.heic,.webp"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileInput}
          />
          <p style={{ margin: '0.75rem 0 0', fontSize: '0.8rem', color: '#999' }}>
            {ACCEPTED_FORMATS_LABEL} — up to {MAX_IMAGES} images
          </p>
          {uploading && <p style={{ color: '#00a89d', margin: '0.5rem 0 0', fontSize: '0.85rem' }}>Uploading…</p>}
        </div>

        {/* Inline error */}
        {fileError && (
          <div role="alert" style={inlineErrorStyle}>
            {fileError}
          </div>
        )}

        {/* Image thumbnails */}
        {images.length > 0 && (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
            {images.map((img) => (
              <div key={img.id} style={thumbContainerStyle}>
                <img
                  src={img.thumbnailUrl}
                  alt={img.filename}
                  style={thumbImgStyle}
                />
                <button
                  onClick={() => removeImage(img.id)}
                  style={thumbRemoveStyle}
                  aria-label={`Remove ${img.filename}`}
                  type="button"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Generate Quote button */}
      <button
        onClick={handleGenerate}
        disabled={!canGenerate}
        style={{ ...btnStyle, opacity: canGenerate ? 1 : 0.5 }}
        type="button"
      >
        {generating ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={spinnerStyle} />
            Generating Quote…
          </span>
        ) : (
          'Generate Quote'
        )}
      </button>

      {/* Import from Jobber section */}
      {jobberAvailable && (
        <div style={{ marginTop: '1.5rem' }}>
          <JobberQuoteImportSection
            onImportSuccess={(draftId) => navigate('/quotes/drafts/' + draftId)}
          />
        </div>
      )}
    </div>
  );
}

// ── Styles ──

const containerStyle: React.CSSProperties = { maxWidth: 700, margin: '0 auto' };
const titleStyle: React.CSSProperties = { margin: '0 0 1.5rem', fontSize: '1.5rem' };

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: '1.25rem',
  fontSize: '0.9rem',
  fontWeight: 500,
};

const textareaStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: '0.25rem',
  padding: '0.5rem',
  border: '1px solid #ccc',
  borderRadius: 4,
  fontSize: '0.9rem',
  boxSizing: 'border-box',
  resize: 'vertical',
  fontFamily: 'inherit',
};

const dropZoneStyle: React.CSSProperties = {
  border: '2px dashed #bbb',
  borderRadius: 8,
  padding: '1.5rem',
  textAlign: 'center',
  transition: 'border-color 0.2s, background 0.2s',
};

const inlineErrorStyle: React.CSSProperties = {
  background: '#fdecea',
  color: '#611a15',
  padding: '0.5rem 0.75rem',
  borderRadius: 4,
  marginTop: '0.5rem',
  fontSize: '0.85rem',
};

const thumbContainerStyle: React.CSSProperties = {
  position: 'relative',
  width: 72,
  height: 72,
  borderRadius: 6,
  overflow: 'hidden',
  border: '1px solid #e0e0e0',
};

const thumbImgStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
};

const thumbRemoveStyle: React.CSSProperties = {
  position: 'absolute',
  top: 2,
  right: 2,
  width: 20,
  height: 20,
  borderRadius: '50%',
  background: 'rgba(0,0,0,0.6)',
  color: '#fff',
  border: 'none',
  cursor: 'pointer',
  fontSize: '0.8rem',
  lineHeight: '20px',
  textAlign: 'center',
  padding: 0,
};

const btnStyle: React.CSSProperties = {
  padding: '0.6rem 1.25rem',
  border: '1px solid #00a89d',
  background: '#00a89d',
  color: '#fff',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: '0.95rem',
  fontWeight: 500,
};

const btnOutlineStyle: React.CSSProperties = {
  padding: '0.4rem 0.75rem',
  border: '1px solid #00a89d',
  background: 'transparent',
  color: '#00a89d',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: '0.85rem',
};

const backBtnStyle: React.CSSProperties = {
  padding: '0.4rem 0.75rem',
  border: 'none',
  background: 'transparent',
  color: '#555',
  cursor: 'pointer',
  fontSize: '0.9rem',
  marginBottom: '0.5rem',
};

const spinnerStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 16,
  height: 16,
  border: '2px solid rgba(255,255,255,0.3)',
  borderTopColor: '#fff',
  borderRadius: '50%',
  animation: 'spin 0.6s linear infinite',
};
