import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  ContentTypeTemplate, ContentSuggestion, MediaItem,
  ChannelConnection, ErrorResponse, ContentType,
  GeneratedImage, ImageStyle, ContentIdea,
} from 'shared';
import { AdvisorMode } from 'shared';
import {
  quickStart, fetchContentTypes, fetchChannels,
  fetchSettings, updateSettings, fetchAdvisorSuggestion,
  createPost, generateContent, approvePost, publishPost,
  generateImages, saveGeneratedImage, updatePost, uploadMedia,
  fetchContentIdeas, generateContentIdeas, useContentIdea, dismissContentIdea,
  resolveMediaUrl,
} from '../api';

type Step = 'loading' | 'content-type' | 'ideas' | 'generating' | 'image' | 'preview' | 'done';

const MAX_CAPTION = 2200;
const MAX_HASHTAGS = 30;

export default function QuickPostPage() {
  const navigate = useNavigate();

  const [templates, setTemplates] = useState<ContentTypeTemplate[]>([]);
  const [channels, setChannels] = useState<ChannelConnection[]>([]);

  const [step, setStep] = useState<Step>('loading');
  const [selectedContentType, setSelectedContentType] = useState<ContentType | ''>('');
  const [suggestion, setSuggestion] = useState<ContentSuggestion | null>(null);
  const [advisorEnabled, setAdvisorEnabled] = useState(true);
  const [advisorMode, setAdvisorMode] = useState<AdvisorMode>(AdvisorMode.Smart);
  const [advisorSaving, setAdvisorSaving] = useState(false);
  const [caption, setCaption] = useState('');
  const [hashtags, setHashtags] = useState<string[]>([]);
  const [savedPostId, setSavedPostId] = useState<string | null>(null);

  // Ideas state
  const [ideas, setIdeas] = useState<ContentIdea[]>([]);
  const [selectedIdea, setSelectedIdea] = useState<ContentIdea | null>(null);
  const [ideasLoading, setIdeasLoading] = useState(false);

  // AI image state
  const [aiStyle, setAiStyle] = useState<ImageStyle>('photorealistic');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [generatedImages, setGeneratedImages] = useState<GeneratedImage[]>([]);
  const [generatedMediaItems, setGeneratedMediaItems] = useState<(MediaItem | undefined)[]>([]);
  const [selectedImage, setSelectedImage] = useState<MediaItem | null>(null);

  // Preview image upload state
  const previewFileInputRef = useRef<HTMLInputElement>(null);
  const [previewUploading, setPreviewUploading] = useState(false);

  // Hashtag editing state
  const [newHashtag, setNewHashtag] = useState('');
  const [hashtagGenerating, setHashtagGenerating] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [genProgress, setGenProgress] = useState(0);
  const [startTime] = useState(Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (step === 'done') return;
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startTime) / 1000)), 1000);
    return () => clearInterval(id);
  }, [startTime, step]);

  const loadData = useCallback(async () => {
    try {
      // Fetch settings, content types, and channels in parallel.
      // quickStart and fetchSettings both need user settings — run them concurrently.
      // Each call is individually caught so one failure doesn't block the others.
      const [settingsRes, typesRes, channelsRes, qsRes] = await Promise.all([
        fetchSettings().catch(() => null),
        fetchContentTypes().catch(() => null),
        fetchChannels().catch(() => null),
        quickStart().catch(() => null),
      ]);

      if (typesRes) setTemplates(typesRes.contentTypes);
      if (channelsRes) setChannels(channelsRes.channels);

      // Determine advisor mode from settings
      let mode = AdvisorMode.Smart;
      if (settingsRes) {
        mode = settingsRes.settings.advisorMode;
        setAdvisorMode(mode);
        setAdvisorEnabled(mode !== AdvisorMode.Manual);
      }

      // Use suggestion from quickStart if available
      let activeSuggestion = qsRes?.suggestion ?? null;

      // If quickStart didn't return a suggestion but advisor is enabled,
      // try the dedicated suggest endpoint as a fallback
      if (!activeSuggestion && mode !== AdvisorMode.Manual) {
        try {
          const suggestRes = await fetchAdvisorSuggestion();
          activeSuggestion = suggestRes.suggestion;
        } catch {
          // Advisor unavailable — continue without suggestion
        }
      }

      setSuggestion(activeSuggestion);

      if (mode !== AdvisorMode.Manual && activeSuggestion) {
        setSelectedContentType(activeSuggestion.contentType);
      } else if (qsRes?.defaults.contentType) {
        setSelectedContentType(qsRes.defaults.contentType);
      }

      setStep('content-type');
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Failed to initialize.');
      setStep('content-type');
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Prefer a fully connected channel; an expired/disconnected/errored one
  // can't publish, so picking channels[0] blindly would surface a misleading
  // "ready to publish" state.
  const channel = channels.find((c) => c.status === 'connected') ?? null;

  // Load ideas for selected content type
  const loadIdeas = async (ct: ContentType) => {
    try {
      setIdeasLoading(true);
      setError(null);
      const result = await fetchContentIdeas(ct);
      if (result.ideas.length > 0) {
        setIdeas(result.ideas);
      } else {
        // Auto-generate first batch
        const genResult = await generateContentIdeas(ct);
        setIdeas(genResult.ideas);
      }
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Failed to load ideas.');
    } finally {
      setIdeasLoading(false);
    }
  };

  // Generate more ideas
  const handleGenerateMoreIdeas = async () => {
    if (!selectedContentType) return;
    try {
      setIdeasLoading(true);
      setError(null);
      const result = await generateContentIdeas(selectedContentType as ContentType);
      setIdeas((prev) => [...result.ideas, ...prev]);
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Failed to generate ideas.');
    } finally {
      setIdeasLoading(false);
    }
  };

  // Pick an idea and move to content generation
  const handlePickIdea = async (idea: ContentIdea) => {
    setSelectedIdea(idea);
    try {
      await useContentIdea(idea.id);
      setIdeas((prev) => prev.filter((i) => i.id !== idea.id));
    } catch { /* non-critical */ }
    handleGenerateContent(idea.idea);
  };

  // Dismiss an idea
  const handleDismissIdea = async (e: React.MouseEvent, idea: ContentIdea) => {
    e.stopPropagation();
    setIdeas((prev) => prev.filter((i) => i.id !== idea.id));
    try {
      await dismissContentIdea(idea.id);
    } catch { /* non-critical */ }
  };

  // Generate content using the idea as context
  const handleGenerateContent = async (ideaText: string) => {
    if (!selectedContentType) return;
    try {
      setStep('generating');
      setError(null);
      setGenProgress(10);
      // Clear any leftover state from a previous post
      clearSelectedImage();
      setGeneratedImages([]);

      const post = await createPost({
        channelConnectionId: channel?.id ?? '',
        contentType: selectedContentType as ContentType,
        caption: '',
        hashtags: [],
      });
      setSavedPostId(post.id);
      setGenProgress(40);

      const result = await generateContent(post.id, { context: ideaText });
      setCaption(result.caption);
      setHashtags(result.hashtags);
      setGenProgress(100);
      setStep('image');
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Content generation failed.');
      setStep('ideas');
    }
  };

  const handleAiGenerate = async () => {
    try {
      setAiGenerating(true);
      setError(null);
      // Send the original content idea as the topic — the server will
      // convert it to a visual scene description via GPT before generating
      const topic = selectedIdea ? selectedIdea.idea : caption.substring(0, 150);
      const result = await generateImages('', aiStyle, 1, topic);
      setGeneratedImages(result.images);
      setGeneratedMediaItems(result.mediaItems ?? result.images.map(() => undefined));
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Image generation failed.');
    } finally {
      setAiGenerating(false);
    }
  };

  const handleSaveGenerated = async (image: GeneratedImage, mediaItem?: MediaItem) => {
    try {
      setActionLoading(true);
      setError(null);
      // Queue pipeline already persisted to R2 + D1; only legacy flows need save-generated.
      const saved = mediaItem ?? await saveGeneratedImage(image);
      // Revoke previous blob URL if replacing an uploaded image
      if (selectedImage?.thumbnailUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(selectedImage.thumbnailUrl);
      }
      setSelectedImage(saved);
      setGeneratedImages([]);
      setGeneratedMediaItems([]);
      if (savedPostId) await updatePost(savedPostId, { mediaItemIds: [saved.id] });
      // Auto-advance to preview
      setStep('preview');
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Failed to save image.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleApproveAndPublish = async () => {
    if (!savedPostId) return;
    if (previewUploading || hashtagGenerating) {
      setError('Please wait for the current upload or hashtag generation to finish.');
      return;
    }
    try {
      setActionLoading(true);
      setError(null);
      // Save latest caption, hashtags, and image before publishing
      await updatePost(savedPostId, {
        caption,
        hashtags,
        mediaItemIds: selectedImage ? [selectedImage.id] : [],
      });
      await approvePost(savedPostId);
      const result = await publishPost(savedPostId);
      if (result.success) {
        setStep('done');
      } else {
        setError(result.error ?? 'Publishing failed.');
        navigate('/social/posts/' + savedPostId);
      }
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Failed to publish.');
    } finally {
      setActionLoading(false);
    }
  };

  // ── Preview image upload handler ──
  const handlePreviewImageUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    const allowed = ['image/jpeg', 'image/png'];
    if (!allowed.includes(file.type)) {
      setError('Please upload a JPEG or PNG image.');
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setError('File exceeds the 50 MB size limit.');
      return;
    }
    try {
      setPreviewUploading(true);
      setError(null);
      const item = await uploadMedia(file);
      // Revoke previous blob URL if one exists to avoid memory leak
      if (selectedImage?.thumbnailUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(selectedImage.thumbnailUrl);
      }
      // The server thumbnailUrl isn't directly servable in dev, so use a local
      // object URL for the preview image.
      item.thumbnailUrl = URL.createObjectURL(file);
      setSelectedImage(item);
      if (savedPostId) await updatePost(savedPostId, { mediaItemIds: [item.id] });
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Upload failed.');
    } finally {
      setPreviewUploading(false);
      // Reset the input so re-uploading the same file triggers onChange
      if (previewFileInputRef.current) previewFileInputRef.current.value = '';
    }
  };

  const clearSelectedImage = () => {
    if (selectedImage?.thumbnailUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(selectedImage.thumbnailUrl);
    }
    setSelectedImage(null);
  };

  // ── Hashtag editing handlers ──
  const handleRemoveHashtag = (tag: string) => {
    setHashtags((prev) => prev.filter((t) => t !== tag));
  };

  const handleAddHashtag = () => {
    const cleaned = newHashtag.trim().replace(/^#/, '').replace(/\s+/g, '');
    if (!cleaned) return;
    if (hashtags.includes(cleaned)) { setNewHashtag(''); return; }
    if (hashtags.length >= MAX_HASHTAGS) { setError('Maximum ' + MAX_HASHTAGS + ' hashtags allowed.'); return; }
    setHashtags((prev) => [...prev, cleaned]);
    setNewHashtag('');
  };

  const handleGenerateMoreHashtags = async () => {
    if (!savedPostId) return;
    try {
      setHashtagGenerating(true);
      setError(null);
      const result = await generateContent(savedPostId, { context: caption.substring(0, 200) });
      const freshTags = result.hashtags || [];
      // Use functional updater to merge against latest hashtags state
      let mergedHashtags: string[] = [];
      setHashtags((prev) => {
        const existing = new Set(prev);
        const newOnes = freshTags.filter((t: string) => !existing.has(t));
        mergedHashtags = [...prev, ...newOnes].slice(0, MAX_HASHTAGS);
        return mergedHashtags;
      });
      // generateContent overwrites the post caption on the server,
      // so restore the user's current caption + merged hashtags.
      // Use a callback to read latest caption via setState no-op trick,
      // but simpler: just persist what we have — the updatePost in
      // handleApproveAndPublish will send the final state before publish.
      setCaption((currentCaption) => {
        updatePost(savedPostId!, { caption: currentCaption, hashtags: mergedHashtags }).catch(() => {});
        return currentCaption;
      });
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Failed to generate hashtags.');
    } finally {
      setHashtagGenerating(false);
    }
  };

  // ── Render ──

  if (step === 'loading') {
    return (
      <div style={containerStyle}>
        <h1 style={titleStyle}>Quick Post</h1>
        <div style={{ textAlign: 'center', padding: '3rem 0' }}>
          <div style={spinnerStyle} />
          <p>Loading your workspace…</p>
        </div>
      </div>
    );
  }

  const stepLabels = ['Content Type', 'Pick Idea', 'Generate', 'Image', 'Preview'];
  const stepKeys: Step[] = ['content-type', 'ideas', 'generating', 'image', 'preview'];

  return (
    <div style={containerStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h1 style={titleStyle}>Quick Post</h1>
        <span style={timerStyle}>{elapsed}s elapsed</span>
      </div>

      <div style={stepBarStyle}>
        {stepLabels.map((label, i) => {
          const currentIdx = stepKeys.indexOf(step === 'done' ? 'preview' : step);
          const isActive = i <= currentIdx;
          return (
            <div key={label} style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ ...stepDotStyle, background: isActive ? '#00a89d' : '#e0e0e0', color: isActive ? '#fff' : '#888' }}>{i + 1}</div>
              <div style={{ fontSize: '0.75rem', color: isActive ? '#00a89d' : '#888', marginTop: 4 }}>{label}</div>
            </div>
          );
        })}
      </div>

      {error && <div role="alert" style={alertStyle}>{error}</div>}

      {/* Step 1: Content Type */}
      {step === 'content-type' && (
        <div>
          {/* Content Advisor Section */}
          <div style={advisorSectionStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: advisorEnabled ? '0.75rem' : 0 }}>
              <div>
                <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>Content Advisor</span>
                <span style={{ color: '#666', fontSize: '0.85rem', marginLeft: '0.5rem' }}>
                  {advisorEnabled ? (advisorMode === AdvisorMode.Smart ? 'Smart mode' : 'Random mode') : 'Off'}
                </span>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                <span style={{ color: '#666' }}>{advisorEnabled ? 'On' : 'Off'}</span>
                <div
                  role="switch"
                  aria-checked={advisorEnabled}
                  tabIndex={0}
                  onClick={async () => {
                    if (advisorSaving) return;
                    const next = !advisorEnabled;
                    setAdvisorSaving(true);
                    try {
                      const newMode = next ? AdvisorMode.Smart : AdvisorMode.Manual;
                      await updateSettings({ advisorMode: newMode });
                      setAdvisorMode(newMode);
                      setAdvisorEnabled(next);
                      if (next) {
                        // Fetch a fresh suggestion when enabling the advisor
                        try {
                          const res = await fetchAdvisorSuggestion();
                          if (res.suggestion) {
                            setSuggestion(res.suggestion);
                            setSelectedContentType(res.suggestion.contentType);
                          }
                        } catch {
                          // Suggestion fetch failed — advisor is on but no suggestion
                        }
                      } else {
                        setSuggestion(null);
                      }
                    } catch {
                      // Revert — leave advisorEnabled unchanged
                    } finally {
                      setAdvisorSaving(false);
                    }
                  }}
                  onKeyDown={(e) => { if (advisorSaving) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
                  style={{
                    width: 40, height: 22, borderRadius: 11, position: 'relative',
                    background: advisorEnabled ? '#4caf50' : '#ccc', transition: 'background 0.2s',
                    opacity: advisorSaving ? 0.6 : 1,
                  }}
                >
                  <div style={{
                    width: 18, height: 18, borderRadius: '50%', background: '#fff',
                    position: 'absolute', top: 2, left: advisorEnabled ? 20 : 2,
                    transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  }} />
                </div>
              </label>
            </div>
            {advisorEnabled && suggestion && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', background: '#e0f7f5', border: '1px solid #80d4ce', borderRadius: 6, padding: '0.6rem 0.75rem' }}>
                <span style={{ fontSize: '1.1rem' }}>💡</span>
                <div style={{ flex: 1, fontSize: '0.85rem' }}>
                  Recommended: <strong>{suggestion.contentType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}</strong>
                  <span style={{ color: '#666', marginLeft: '0.5rem' }}>— {suggestion.reason}</span>
                </div>
              </div>
            )}
            {advisorEnabled && !suggestion && (
              <div style={{ fontSize: '0.85rem', color: '#888' }}>No suggestion available right now. Pick a content type below.</div>
            )}
          </div>

          <p style={{ margin: '0 0 0.75rem', fontWeight: 500 }}>
            {advisorEnabled && suggestion ? 'Content type pre-selected by advisor. You can override it:' : 'Select a content type:'}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
            {templates.map((t) => {
              const isSelected = selectedContentType === t.contentType;
              return (
                <div key={t.contentType} onClick={() => setSelectedContentType(t.contentType)} role="button" tabIndex={0} aria-pressed={isSelected}
                  aria-label={'Select ' + t.displayName}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedContentType(t.contentType); } }}
                  style={{ ...cardStyle, border: isSelected ? '2px solid #00a89d' : '1px solid #e0e0e0', cursor: 'pointer' }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{t.displayName}</div>
                  <div style={{ fontSize: '0.8rem', color: '#666' }}>{t.description}</div>
                </div>
              );
            })}
          </div>
          <button onClick={() => { if (selectedContentType) { loadIdeas(selectedContentType as ContentType); setStep('ideas'); } }}
            disabled={!selectedContentType} style={{ ...btnStyle, opacity: selectedContentType ? 1 : 0.5 }}>
            Next: Pick an Idea →
          </button>

        </div>
      )}

      {/* Step 2: Pick an Idea */}
      {step === 'ideas' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <p style={{ margin: 0, fontWeight: 500 }}>Pick a content idea:</p>
            <button onClick={() => setStep('content-type')} style={linkBtnStyle}>← Back</button>
          </div>

          {ideasLoading && ideas.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem 0' }}>
              <div style={spinnerStyle} />
              <p style={{ color: '#888', marginTop: '0.75rem' }}>Generating ideas...</p>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
                {ideas.map((idea) => (
                  <div key={idea.id} onClick={() => handlePickIdea(idea)} role="button" tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlePickIdea(idea); } }}
                    style={ideaCardStyle}>
                    <span style={{ flex: 1 }}>{idea.idea}</span>
                    <button onClick={(e) => handleDismissIdea(e, idea)} title="Dismiss idea"
                      style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer', fontSize: '1rem', padding: '0 0.25rem', lineHeight: 1 }}
                      aria-label="Dismiss idea">✕</button>
                    <span style={{ color: '#00a89d', fontSize: '0.8rem', whiteSpace: 'nowrap', marginLeft: '0.5rem' }}>Use this →</span>
                  </div>
                ))}
              </div>
              <button onClick={handleGenerateMoreIdeas} disabled={ideasLoading}
                style={{ ...btnOutlineStyle, opacity: ideasLoading ? 0.5 : 1 }}>
                {ideasLoading ? 'Generating...' : '🔄 Generate More Ideas'}
              </button>
            </>
          )}
        </div>
      )}

      {/* Step 3: Generating content */}
      {step === 'generating' && (
        <div style={{ textAlign: 'center', padding: '2rem 0' }}>
          <div style={spinnerStyle} />
          <p style={{ fontWeight: 500, marginTop: '1rem' }}>Generating content…</p>
          <div style={progressBarContainerStyle}>
            <div style={{ ...progressBarFillStyle, width: genProgress + '%' }} />
          </div>
          <p style={{ fontSize: '0.85rem', color: '#888' }}>
            {genProgress < 40 ? 'Creating post…' : 'Generating caption and hashtags…'}
          </p>
          {selectedIdea && (
            <p style={{ fontSize: '0.8rem', color: '#666', marginTop: '0.5rem' }}>
              Based on: {selectedIdea.idea}
            </p>
          )}
        </div>
      )}

      {/* Step 4: Image generation */}
      {step === 'image' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <p style={{ margin: 0, fontWeight: 500 }}>Generate an image for your post</p>
            <button onClick={() => setStep('ideas')} style={linkBtnStyle}>← Back</button>
          </div>
          <div style={{ background: '#f5f5f5', border: '1px solid #e0e0e0', borderRadius: 8, padding: '0.75rem', marginBottom: '1rem' }}>
            <div style={{ fontSize: '0.8rem', color: '#888', marginBottom: '0.25rem' }}>Generated caption:</div>
            <div style={{ fontSize: '0.85rem', color: '#333' }}>{caption.substring(0, 200)}{caption.length > 200 ? '...' : ''}</div>
          </div>
          <div style={aiGenSectionStyle}>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', alignItems: 'center' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 500 }}>Style:</span>
              <select value={aiStyle} onChange={(e) => setAiStyle(e.target.value as ImageStyle)}
                style={{ ...inputStyle, width: 'auto', marginTop: 0 }} aria-label="Image style">
                <option value="photorealistic">Photo</option>
                <option value="modern">Modern</option>
                <option value="illustrative">Illustration</option>
              </select>
              <button onClick={handleAiGenerate} disabled={aiGenerating}
                style={{ ...btnStyle, opacity: aiGenerating ? 0.5 : 1 }}>
                {aiGenerating ? 'Generating...' : '✨ Generate Image from Caption'}
              </button>
            </div>
            {aiGenerating && <p style={{ fontSize: '0.8rem', color: '#888', margin: '0.25rem 0' }}>Image generation can take up to 2 minutes...</p>}
            {generatedImages.length > 0 && (
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
                {generatedImages.map((img, i) => (
                  <div key={i} style={{ width: 200, borderRadius: 8, overflow: 'hidden', border: '2px solid #80d4ce' }}>
                    <img src={resolveMediaUrl(img.url)} alt={img.description} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }} />
                    <button onClick={() => handleSaveGenerated(img, generatedMediaItems[i])} disabled={actionLoading}
                      style={{ width: '100%', padding: '0.5rem', border: 'none', background: '#00a89d', color: '#fff', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 500 }}>
                      {actionLoading ? 'Saving...' : 'Use This Image'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '0.75rem 0' }}>
            <div style={{ flex: 1, height: 1, background: '#e0e0e0' }} />
            <span style={{ fontSize: '0.8rem', color: '#888' }}>or</span>
            <div style={{ flex: 1, height: 1, background: '#e0e0e0' }} />
          </div>
          <input
            ref={previewFileInputRef}
            type="file"
            accept="image/jpeg,image/png"
            style={{ display: 'none' }}
            onChange={(e) => handlePreviewImageUpload(e.target.files)}
          />
          <button
            onClick={() => previewFileInputRef.current?.click()}
            disabled={previewUploading}
            style={{ ...btnOutlineStyle, width: '100%', opacity: previewUploading ? 0.5 : 1 }}
          >
            {previewUploading ? 'Uploading…' : '📁 Upload Image from Device'}
          </button>
          {selectedImage && (
            <div style={{ marginTop: '1rem', padding: '0.75rem', background: '#e0f7f5', border: '1px solid #80d4ce', borderRadius: 8, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <img src={resolveMediaUrl(selectedImage.thumbnailUrl)} alt="Selected" style={{ width: 60, height: 60, borderRadius: 6, objectFit: 'cover' }} />
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: '0.85rem', color: '#00a89d', fontWeight: 500 }}>Image attached to post</span>
              </div>
              <button onClick={() => { clearSelectedImage(); setGeneratedImages([]); setGeneratedMediaItems([]); }}
                style={{ background: 'none', border: 'none', color: '#d32f2f', cursor: 'pointer', fontSize: '0.85rem' }}>✕ Remove</button>
            </div>
          )}
          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem' }}>
            <button onClick={() => setStep('preview')} style={btnStyle}>
              {selectedImage ? 'Next: Preview →' : 'Skip Image → Preview'}
            </button>
            <button onClick={() => setStep('ideas')} style={btnOutlineStyle}>← Back</button>
          </div>
        </div>
      )}

      {/* Step 5: Preview + Approve */}
      {step === 'preview' && (
        <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <p style={{ margin: 0, fontWeight: 500 }}>Review &amp; Approve</p>
              <button onClick={() => setStep('image')} style={linkBtnStyle}>← Back to Image</button>
            </div>
            <label style={labelStyle}>
              <span style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Caption</span>
                <span style={{ fontSize: '0.8rem', color: caption.length > MAX_CAPTION ? '#d32f2f' : '#888' }}>{caption.length}/{MAX_CAPTION}</span>
              </span>
              <textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={6}
                style={{ ...inputStyle, borderColor: caption.length > MAX_CAPTION ? '#d32f2f' : '#ccc' }} />
            </label>

            {/* ── Image upload section ── */}
            <div style={{ marginBottom: '1rem' }}>
              <span style={{ fontWeight: 500, fontSize: '0.9rem', display: 'block', marginBottom: '0.5rem' }}>Image</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                {selectedImage ? (
                  <img src={resolveMediaUrl(selectedImage.thumbnailUrl)} alt="Selected" style={{ width: 80, height: 80, borderRadius: 8, objectFit: 'cover', border: '1px solid #e0e0e0' }} />
                ) : (
                  <div style={{ width: 80, height: 80, borderRadius: 8, background: '#f5f5f5', border: '1px dashed #ccc', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999', fontSize: '0.75rem' }}>No image</div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <input
                    ref={previewFileInputRef}
                    type="file"
                    accept="image/jpeg,image/png"
                    style={{ display: 'none' }}
                    onChange={(e) => handlePreviewImageUpload(e.target.files)}
                  />
                  <button
                    onClick={() => previewFileInputRef.current?.click()}
                    disabled={previewUploading}
                    style={{ ...btnOutlineStyle, fontSize: '0.8rem', padding: '0.35rem 0.75rem', opacity: previewUploading ? 0.5 : 1 }}
                  >
                    {previewUploading ? 'Uploading…' : '📁 Upload from Device'}
                  </button>
                  {selectedImage && (
                    <button
                      onClick={() => clearSelectedImage()}
                      style={{ ...linkBtnStyle, fontSize: '0.8rem', textAlign: 'left', color: '#d32f2f' }}
                    >
                      ✕ Remove image
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* ── Hashtag editing section ── */}
            <div style={{ marginBottom: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                <span style={{ fontWeight: 500, fontSize: '0.9rem' }}>Hashtags</span>
                <span style={{ fontSize: '0.8rem', color: hashtags.length > MAX_HASHTAGS ? '#d32f2f' : '#888' }}>{hashtags.length}/{MAX_HASHTAGS}</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginBottom: '0.5rem' }}>
                {hashtags.map((tag) => (
                  <span key={tag} style={hashtagChipEditableStyle}>
                    #{tag}
                    <button
                      onClick={() => handleRemoveHashtag(tag)}
                      title={'Remove #' + tag}
                      aria-label={'Remove hashtag ' + tag}
                      style={{ background: 'none', border: 'none', color: '#00897b', cursor: 'pointer', fontSize: '0.85rem', marginLeft: '0.25rem', padding: 0, lineHeight: 1 }}
                    >✕</button>
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input
                  type="text"
                  value={newHashtag}
                  onChange={(e) => setNewHashtag(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddHashtag(); } }}
                  placeholder="Add a hashtag…"
                  style={{ ...inputStyle, marginTop: 0, flex: 1 }}
                  aria-label="Add a hashtag"
                />
                <button onClick={handleAddHashtag} disabled={!newHashtag.trim()} style={{ ...btnOutlineStyle, fontSize: '0.8rem', padding: '0.4rem 0.75rem', whiteSpace: 'nowrap', opacity: newHashtag.trim() ? 1 : 0.5 }}>
                  + Add
                </button>
                <button onClick={handleGenerateMoreHashtags} disabled={hashtagGenerating} style={{ ...btnOutlineStyle, fontSize: '0.8rem', padding: '0.4rem 0.75rem', whiteSpace: 'nowrap', opacity: hashtagGenerating ? 0.5 : 1 }}>
                  {hashtagGenerating ? 'Generating…' : '✨ Generate More'}
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              {!channel && (
                <div style={{ width: '100%', background: '#fff3e0', border: '1px solid #ffe0b2', borderRadius: 4, padding: '0.5rem 0.75rem', marginBottom: '0.5rem', fontSize: '0.85rem', color: '#e65100' }}>
                  No Instagram channel connected. Connect one in Settings to publish.
                </div>
              )}
              <button onClick={handleApproveAndPublish}
                disabled={actionLoading || previewUploading || hashtagGenerating || !channel || caption.length > MAX_CAPTION || hashtags.length > MAX_HASHTAGS}
                style={{ ...publishBtnStyle, opacity: (actionLoading || previewUploading || hashtagGenerating || !channel) ? 0.5 : 1 }}>
                {actionLoading ? 'Publishing…' : 'Approve & Publish'}
              </button>

            </div>
          </div>
          <div style={{ width: 320, flexShrink: 0 }}>
            <div style={previewPanelStyle}>
              <h3 style={{ margin: '0 0 0.75rem', fontSize: '0.95rem' }}>Instagram Preview</h3>
              <div style={previewCardStyle}>
                <div style={{ display: 'flex', alignItems: 'center', padding: '0.5rem', gap: '0.5rem' }}>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#0a1e24' }} />
                  <span style={{ fontWeight: 600, fontSize: '0.8rem' }}>chicago_reno</span>
                </div>
                <div style={{ background: '#e0e0e0', aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                  {selectedImage ? (
                    <img src={resolveMediaUrl(selectedImage.thumbnailUrl)} alt="Preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (<span style={{ color: '#999', fontSize: '0.85rem' }}>No image</span>)}
                </div>
                <div style={{ padding: '0.5rem', fontSize: '0.8rem' }}>
                  <span style={{ fontWeight: 600 }}>chicago_reno </span>
                  <span>{caption || 'Caption…'}</span>
                </div>
                {hashtags.length > 0 && (
                  <div style={{ padding: '0 0.5rem 0.5rem', fontSize: '0.8rem', color: '#00376b' }}>
                    {hashtags.map((t) => '#' + t).join(' ')}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {step === 'done' && (
        <div style={{ textAlign: 'center', padding: '2rem 0' }}>
          <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>✅</div>
          <h2 style={{ margin: '0 0 0.5rem' }}>Published!</h2>
          <p style={{ color: '#666', marginBottom: '1rem' }}>Your post was created and published in {elapsed} seconds.</p>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
            <button onClick={() => navigate('/social/dashboard')} style={btnStyle}>Go to Dashboard</button>
            <button onClick={() => window.location.reload()} style={btnOutlineStyle}>Create Another</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ──

const containerStyle: React.CSSProperties = { maxWidth: 900, margin: '0 auto' };
const titleStyle: React.CSSProperties = { margin: 0, fontSize: '1.5rem' };
const timerStyle: React.CSSProperties = { fontSize: '0.85rem', color: '#888', fontFamily: 'monospace' };
const stepBarStyle: React.CSSProperties = { display: 'flex', marginBottom: '1.5rem', padding: '0.75rem 0', borderBottom: '1px solid #e0e0e0' };
const stepDotStyle: React.CSSProperties = { width: 28, height: 28, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', fontWeight: 700, margin: '0 auto' };

const btnStyle: React.CSSProperties = { padding: '0.5rem 1rem', border: '1px solid #00a89d', background: '#00a89d', color: '#fff', borderRadius: 4, cursor: 'pointer', fontSize: '0.9rem' };
const btnOutlineStyle: React.CSSProperties = { padding: '0.5rem 1rem', border: '1px solid #00a89d', background: 'transparent', color: '#00a89d', borderRadius: 4, cursor: 'pointer', fontSize: '0.9rem' };
const publishBtnStyle: React.CSSProperties = { padding: '0.6rem 1.25rem', border: '1px solid #00a89d', background: '#00a89d', color: '#fff', borderRadius: 4, cursor: 'pointer', fontSize: '0.9rem', fontWeight: 500 };
const linkBtnStyle: React.CSSProperties = { background: 'none', border: 'none', color: '#00a89d', cursor: 'pointer', fontSize: '0.85rem' };

const alertStyle: React.CSSProperties = { background: '#fdecea', color: '#611a15', padding: '0.75rem 1rem', borderRadius: 4, marginBottom: '1rem' };
const advisorSectionStyle: React.CSSProperties = { background: '#fff', border: '1px solid #e0e0e0', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '1rem' };
const cardStyle: React.CSSProperties = { background: '#fff', borderRadius: 8, padding: '1rem' };
const labelStyle: React.CSSProperties = { display: 'block', marginBottom: '0.75rem', fontSize: '0.9rem', fontWeight: 500 };
const inputStyle: React.CSSProperties = { display: 'block', width: '100%', marginTop: '0.25rem', padding: '0.5rem', border: '1px solid #ccc', borderRadius: 4, fontSize: '0.9rem', boxSizing: 'border-box' };
const hashtagChipEditableStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', background: '#e0f7f5', color: '#00a89d', padding: '0.2rem 0.5rem', borderRadius: 12, fontSize: '0.8rem', gap: '0.15rem' };

const ideaCardStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', padding: '0.75rem 1rem', background: '#fff',
  border: '1px solid #e0e0e0', borderRadius: 8, cursor: 'pointer', fontSize: '0.9rem',
  transition: 'border-color 0.15s',
};

const aiGenSectionStyle: React.CSSProperties = { background: '#f5f5f5', border: '1px solid #e0e0e0', borderRadius: 8, padding: '0.75rem', marginBottom: '0.5rem' };
const previewPanelStyle: React.CSSProperties = { background: '#fff', border: '1px solid #e0e0e0', borderRadius: 8, padding: '1rem', position: 'sticky', top: '1.5rem' };
const previewCardStyle: React.CSSProperties = { border: '1px solid #dbdbdb', borderRadius: 6, overflow: 'hidden', background: '#fff' };
const spinnerStyle: React.CSSProperties = { width: 40, height: 40, border: '4px solid #e0e0e0', borderTopColor: '#00a89d', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto' };
const progressBarContainerStyle: React.CSSProperties = { width: '60%', margin: '1rem auto', height: 6, background: '#e0e0e0', borderRadius: 3, overflow: 'hidden' };
const progressBarFillStyle: React.CSSProperties = { height: '100%', background: '#00a89d', borderRadius: 3, transition: 'width 0.3s ease' };
