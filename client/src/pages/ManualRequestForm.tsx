import { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MediaItem, CreateManualRequestPayload } from 'shared';
import { uploadMedia, createManualRequest, generateQuote } from '../api';

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

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ValidationErrors {
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  customerAddress?: string;
  serviceDescription?: string;
}

function validate(fields: {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customerAddress: string;
  serviceDescription: string;
}): ValidationErrors {
  const errors: ValidationErrors = {};

  if (!fields.customerName.trim()) {
    errors.customerName = 'Customer name is required.';
  } else if (fields.customerName.trim().length > 200) {
    errors.customerName = 'Customer name must be 200 characters or less.';
  }

  if (fields.customerEmail.trim() && !EMAIL_REGEX.test(fields.customerEmail.trim())) {
    errors.customerEmail = 'Enter a valid email address.';
  }

  if (fields.customerPhone.trim().length > 30) {
    errors.customerPhone = 'Phone number must be 30 characters or less.';
  }

  if (fields.customerAddress.trim().length > 500) {
    errors.customerAddress = 'Address must be 500 characters or less.';
  }

  if (!fields.serviceDescription.trim()) {
    errors.serviceDescription = 'Service description is required.';
  } else if (fields.serviceDescription.trim().length > 10000) {
    errors.serviceDescription = 'Service description must be 10,000 characters or less.';
  }

  return errors;
}

export default function ManualRequestForm() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [serviceDescription, setServiceDescription] = useState('');
  const [images, setImages] = useState<MediaItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const validateAndUploadFiles = useCallback(async (files: FileList | File[]) => {
    setFileError(null);
    const fileArray = Array.from(files);

    for (const file of fileArray) {
      if (!ACCEPTED_MIME_TYPES.has(file.type)) {
        setFileError(
          `"${file.name}" is not an accepted format. Accepted formats: ${ACCEPTED_FORMATS_LABEL}.`
        );
        return;
      }
    }

    if (images.length + fileArray.length > MAX_IMAGES) {
      setFileError(`You can upload a maximum of ${MAX_IMAGES} images.`);
      return;
    }

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

  const handleSubmit = async () => {
    setSubmitError(null);

    const errors = validate({
      customerName,
      customerEmail,
      customerPhone,
      customerAddress,
      serviceDescription,
    });
    setValidationErrors(errors);

    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      const payload: CreateManualRequestPayload = {
        customerName: customerName.trim(),
        serviceDescription: serviceDescription.trim(),
      };
      if (customerPhone.trim()) payload.customerPhone = customerPhone.trim();
      if (customerEmail.trim()) payload.customerEmail = customerEmail.trim();
      if (customerAddress.trim()) payload.customerAddress = customerAddress.trim();
      if (images.length > 0) payload.mediaItemIds = images.map((img) => img.id);

      const manualRequest = await createManualRequest(payload);

      const draft = await generateQuote({
        customerText: serviceDescription.trim(),
        mediaItemIds: images.length > 0 ? images.map((img) => img.id) : undefined,
        manualRequestId: manualRequest.id,
      });

      navigate('/quotes/drafts/' + draft.id);
    } catch (err) {
      setSubmitError(extractErrorMessage(err, 'Failed to create request. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={containerStyle}>
      <h1 style={titleStyle}>Create Manual Request</h1>

      {/* Customer Name */}
      <label style={labelStyle}>
        Customer Name <span style={requiredStyle}>*</span>
        <input
          type="text"
          value={customerName}
          onChange={(e) => setCustomerName(e.target.value)}
          placeholder="Enter customer name"
          style={inputStyle}
          disabled={submitting}
          aria-label="Customer name"
          aria-required="true"
        />
      </label>
      {validationErrors.customerName && (
        <div role="alert" style={fieldErrorStyle}>{validationErrors.customerName}</div>
      )}

      {/* Customer Phone */}
      <label style={labelStyle}>
        Phone Number
        <input
          type="tel"
          value={customerPhone}
          onChange={(e) => setCustomerPhone(e.target.value)}
          placeholder="Enter phone number"
          style={inputStyle}
          disabled={submitting}
          aria-label="Customer phone number"
        />
      </label>
      {validationErrors.customerPhone && (
        <div role="alert" style={fieldErrorStyle}>{validationErrors.customerPhone}</div>
      )}

      {/* Customer Email */}
      <label style={labelStyle}>
        Email Address
        <input
          type="email"
          value={customerEmail}
          onChange={(e) => setCustomerEmail(e.target.value)}
          placeholder="Enter email address"
          style={inputStyle}
          disabled={submitting}
          aria-label="Customer email address"
        />
      </label>
      {validationErrors.customerEmail && (
        <div role="alert" style={fieldErrorStyle}>{validationErrors.customerEmail}</div>
      )}

      {/* Customer Address */}
      <label style={labelStyle}>
        Property Address
        <input
          type="text"
          value={customerAddress}
          onChange={(e) => setCustomerAddress(e.target.value)}
          placeholder="Enter property address"
          style={inputStyle}
          disabled={submitting}
          aria-label="Customer property address"
        />
      </label>
      {validationErrors.customerAddress && (
        <div role="alert" style={fieldErrorStyle}>{validationErrors.customerAddress}</div>
      )}

      {/* Service Description */}
      <label style={labelStyle}>
        Service Description <span style={requiredStyle}>*</span>
        <textarea
          value={serviceDescription}
          onChange={(e) => setServiceDescription(e.target.value)}
          placeholder="Describe the work the customer is requesting…"
          rows={6}
          style={textareaStyle}
          disabled={submitting}
          aria-label="Service description"
          aria-required="true"
        />
      </label>
      {validationErrors.serviceDescription && (
        <div role="alert" style={fieldErrorStyle}>{validationErrors.serviceDescription}</div>
      )}

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
            disabled={uploading || submitting}
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

        {fileError && (
          <div role="alert" style={inlineErrorStyle}>
            {fileError}
          </div>
        )}

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

      {/* Submit error */}
      {submitError && (
        <div role="alert" style={inlineErrorStyle}>
          {submitError}
        </div>
      )}

      {/* Submit button */}
      <button
        onClick={handleSubmit}
        disabled={submitting}
        style={{ ...btnStyle, opacity: submitting ? 0.5 : 1 }}
        type="button"
      >
        {submitting ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={spinnerStyle} />
            Generating Quote…
          </span>
        ) : (
          'Create Request & Generate Quote'
        )}
      </button>
    </div>
  );
}

// ── Styles ──

const containerStyle: React.CSSProperties = { maxWidth: 700, margin: '0 auto' };
const titleStyle: React.CSSProperties = { margin: '0 0 1.5rem', fontSize: '1.5rem' };

const requiredStyle: React.CSSProperties = { color: '#d32f2f' };

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: '0.5rem',
  fontSize: '0.9rem',
  fontWeight: 500,
};

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: '0.25rem',
  marginBottom: '0.75rem',
  padding: '0.5rem',
  border: '1px solid #ccc',
  borderRadius: 4,
  fontSize: '0.9rem',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
};

const textareaStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: '0.25rem',
  marginBottom: '0.75rem',
  padding: '0.5rem',
  border: '1px solid #ccc',
  borderRadius: 4,
  fontSize: '0.9rem',
  boxSizing: 'border-box',
  resize: 'vertical',
  fontFamily: 'inherit',
};

const fieldErrorStyle: React.CSSProperties = {
  color: '#d32f2f',
  fontSize: '0.8rem',
  marginTop: '-0.5rem',
  marginBottom: '0.75rem',
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
  marginBottom: '0.75rem',
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

const spinnerStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 16,
  height: 16,
  border: '2px solid rgba(255,255,255,0.3)',
  borderTopColor: '#fff',
  borderRadius: '50%',
  animation: 'spin 0.6s linear infinite',
};
