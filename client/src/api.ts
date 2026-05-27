import type {
  User, ErrorResponse, MediaItem, GeneratedImage, ImageStyle,
  ContentTypeTemplate, ContentSuggestion, Post, GeneratedContent,
  ChannelConnection, PublishResult, ContentType, UserSettings,
  ActivityLogEntry, AdvisorMode, ContentIdea, QuoteDraft,
  ProductCatalogEntry, QuoteTemplate, QuoteDraftUpdate, ActionItem,
  JobberCustomerRequest, SimilarQuote, JobberRequestFormData,
  Rule, RuleGroup, RuleGroupWithRules, SystemsStatusResponse,
  RuleCondition, RuleAction, TriggerMode,
  ManualRequest, CreateManualRequestPayload,
  ProductivityRate, UpdateProductivityRatePayload,
  DeathclockState,
} from 'shared';

/** A manual request row returned by the list endpoint with deathclock enrichment. */
export interface ManualRequestWithDeathclock extends ManualRequest {
  ageSeconds: number;
  quoteSentAt: string | null;
  deathclock: DeathclockState;
}

const TOKEN_KEY = 'session_token';

export const API_BASE = import.meta.env.PROD
  ? (import.meta.env.VITE_API_URL || 'https://social-media-cross-poster.chicago-reno.workers.dev')
  : '';

// Global error listener for toast notifications
type ErrorListener = (error: ErrorResponse) => void;
let globalErrorListener: ErrorListener | null = null;

export function setGlobalErrorListener(listener: ErrorListener | null): void {
  globalErrorListener = listener;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: 'Bearer ' + token } : {};
}

async function parseErrorBody(res: Response): Promise<ErrorResponse> {
  const body = await res.json().catch(() => null);
  if (body && 'severity' in body) {
    return body as ErrorResponse;
  }
  const msg = (body && typeof body.error === 'string') ? body.error : 'Request failed (' + res.status + ')';
  return { severity: 'error', component: 'API', operation: '', message: msg, actions: [] } satisfies ErrorResponse;
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    throw await parseErrorBody(res);
  }
  return res.json();
}

// OPT-IN TOAST: Used only for explicit user-initiated actions.
async function handleResponseWithToast<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const error = await parseErrorBody(res);
    globalErrorListener?.(error);
    throw error;
  }
  return res.json();
}

export async function login(email: string): Promise<{ user: User; token: string }> {
  const res = await fetch(API_BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  return handleResponseWithToast(res);
}

export async function verifySession(): Promise<{ valid: boolean; user?: User }> {
  const res = await fetch(API_BASE + '/api/auth/verify', {
    method: 'POST',
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}

export async function logout(): Promise<void> {
  await fetch(API_BASE + '/api/auth/logout', {
    method: 'POST',
    headers: { ...authHeaders() },
  });
  clearToken();
}

// ── Systems Status ──

export async function fetchSystemsStatus(): Promise<SystemsStatusResponse> {
  const res = await fetch(API_BASE + '/api/systems/status', {
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}

export async function triggerCookieRefresh(): Promise<{ triggered: boolean; message?: string; error?: string }> {
  const res = await fetch(API_BASE + '/api/jobber-auth/trigger-cookie-refresh', {
    method: 'POST',
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}

// ── Media Library ──

export async function listMedia(page = 1, limit = 20): Promise<{ items: MediaItem[]; page: number; limit: number }> {
  const res = await fetch(API_BASE + '/api/media?page=' + page + '&limit=' + limit, {
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}

export async function uploadMedia(file: File): Promise<MediaItem> {
  const res = await fetch(API_BASE + '/api/media/upload', {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': file.type,
      'X-Filename': file.name,
    },
    body: file,
  });
  return handleResponseWithToast(res);
}

export async function generateImages(description: string, style?: ImageStyle, count?: number, topic?: string): Promise<{ images: GeneratedImage[]; mediaItems?: MediaItem[] }> {
  // Enqueue the generation job
  const enqueueRes = await fetch(API_BASE + '/api/media/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ description, style, count, topic }),
  });
  const { jobId } = await handleResponseWithToast<{ jobId: string }>(enqueueRes);

  // Poll for completion
  const POLL_INTERVAL = 2000;
  const MAX_POLLS = 90; // 3 minutes max
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    const statusRes = await fetch(API_BASE + '/api/media/generate-status/' + jobId, {
      headers: { ...authHeaders() },
    });
    const status = await handleResponse<{
      jobId: string;
      status: string;
      error?: string;
      mediaItem?: MediaItem;
    }>(statusRes);

    if (status.status === 'completed' && status.mediaItem) {
      // Build a GeneratedImage for backward compat, but also return the saved MediaItem
      const img: GeneratedImage = {
        url: status.mediaItem.thumbnailUrl || status.mediaItem.storageKey,
        format: status.mediaItem.mimeType === 'image/png' ? 'png' : 'jpeg',
        width: status.mediaItem.width ?? 1024,
        height: status.mediaItem.height ?? 1024,
        description: status.mediaItem.aiDescription || description || topic || '',
      };
      return { images: [img], mediaItems: [status.mediaItem] };
    }

    if (status.status === 'failed') {
      const error: ErrorResponse = {
        severity: 'error',
        component: 'ImageGenerator',
        operation: 'generate',
        message: status.error || 'Image generation failed.',
        actions: ['Try again'],
      };
      globalErrorListener?.(error);
      throw error;
    }
  }

  // Timed out
  const error: ErrorResponse = {
    severity: 'error',
    component: 'ImageGenerator',
    operation: 'generate',
    message: 'Image generation timed out. Please try again.',
    actions: ['Try again'],
  };
  globalErrorListener?.(error);
  throw error;
}

export async function saveGeneratedImage(image: GeneratedImage): Promise<MediaItem> {
  const res = await fetch(API_BASE + '/api/media/temp/save-generated', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(image),
  });
  return handleResponseWithToast(res);
}

export async function deleteMedia(id: string): Promise<void> {
  const res = await fetch(API_BASE + '/api/media/' + id, {
    method: 'DELETE',
    headers: { ...authHeaders() },
  });
  await handleResponseWithToast(res);
}

// ── Content Types & Advisor ──

export async function fetchContentTypes(): Promise<{ contentTypes: ContentTypeTemplate[] }> {
  const res = await fetch(API_BASE + '/api/content-types', {
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}

// ── Channels ──

export async function fetchChannels(): Promise<{ channels: ChannelConnection[] }> {
  const res = await fetch(API_BASE + '/api/channels', {
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}

// ── Posts ──

export async function fetchPost(id: string): Promise<Post> {
  const res = await fetch(API_BASE + '/api/posts/' + id, {
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}

export async function fetchPosts(): Promise<{ posts: Post[]; page: number; limit: number }> {
  const res = await fetch(API_BASE + '/api/posts', {
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}

export async function createPost(data: {
  channelConnectionId: string;
  contentType: ContentType;
  caption: string;
  hashtags: string[];
  templateFields?: Record<string, string>;
  mediaItemIds?: string[];
}): Promise<Post> {
  const res = await fetch(API_BASE + '/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  });
  return handleResponseWithToast(res);
}

export async function updatePost(id: string, data: {
  caption?: string;
  hashtags?: string[];
  contentType?: ContentType;
  channelConnectionId?: string;
  templateFields?: Record<string, string>;
  mediaItemIds?: string[];
}): Promise<Post> {
  const res = await fetch(API_BASE + '/api/posts/' + id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  });
  return handleResponseWithToast(res);
}

export async function generateContent(postId: string, data?: {
  context?: string;
  templateFields?: Record<string, string>;
}): Promise<GeneratedContent> {
  const res = await fetch(API_BASE + '/api/posts/' + postId + '/generate-content', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data ?? {}),
  });
  return handleResponseWithToast(res);
}

export async function approvePost(id: string): Promise<{ success: boolean }> {
  const res = await fetch(API_BASE + '/api/posts/' + id + '/approve', {
    method: 'POST',
    headers: { ...authHeaders() },
  });
  return handleResponseWithToast(res);
}

export async function publishPost(id: string): Promise<PublishResult> {
  const res = await fetch(API_BASE + '/api/posts/' + id + '/publish', {
    method: 'POST',
    headers: { ...authHeaders() },
  });
  return handleResponseWithToast(res);
}

// ── Quick-Post Workflow ──

export interface QuickStartResponse {
  suggestion: ContentSuggestion | null;
  mediaThumbnails: MediaItem[];
  defaults: {
    contentType: ContentType | null;
    hashtagCount: number;
    instagramFormat: {
      recommendedDimensions: {
        square: { width: number; height: number };
        portrait: { width: number; height: number };
        landscape: { width: number; height: number };
      };
      maxCaptionLength: number;
      maxCarouselImages: number;
      maxReelDuration: number;
      supportedMediaTypes: string[];
    };
  };
}

export async function quickStart(): Promise<QuickStartResponse> {
  const res = await fetch(API_BASE + '/api/posts/quick-start', {
    method: 'POST',
    headers: { ...authHeaders() },
  });
  return handleResponseWithToast(res);
}

export async function fetchAdvisorSuggestion(): Promise<{ suggestion: ContentSuggestion | null }> {
  const res = await fetch(API_BASE + '/api/content-advisor/suggest', {
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}

// ── Settings ──

export async function fetchSettings(): Promise<{ settings: UserSettings }> {
  const res = await fetch(API_BASE + '/api/settings', {
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}

export async function updateSettings(data: {
  advisorMode?: AdvisorMode;
}): Promise<{ settings: UserSettings }> {
  const res = await fetch(API_BASE + '/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  });
  return handleResponseWithToast(res);
}

// ── Channels (connect/disconnect) ──

export async function connectInstagram(): Promise<{ authorizationUrl: string; state: string }> {
  const res = await fetch(API_BASE + '/api/channels/instagram/connect', {
    method: 'POST',
    headers: { ...authHeaders() },
  });
  return handleResponseWithToast(res);
}

export async function disconnectChannel(id: string): Promise<{ success: boolean }> {
  const res = await fetch(API_BASE + '/api/channels/' + id, {
    method: 'DELETE',
    headers: { ...authHeaders() },
  });
  return handleResponseWithToast(res);
}

export async function refreshInstagramToken(id: string): Promise<{ channel: ChannelConnection }> {
  const res = await fetch(API_BASE + '/api/channels/instagram/refresh/' + id, {
    method: 'POST',
    headers: { ...authHeaders() },
  });
  return handleResponseWithToast(res);
}

export async function syncInstagramPosts(): Promise<{ synced: number; skipped: number; errors: string[] }> {
  const res = await fetch(API_BASE + '/api/channels/instagram/sync', {
    method: 'POST',
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}

// ── Activity Log ──

export async function fetchActivityLog(page = 1, limit = 20): Promise<{ entries: ActivityLogEntry[]; page: number; limit: number }> {
  const res = await fetch(API_BASE + '/api/activity-log?page=' + page + '&limit=' + limit, {
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}

// ── Content Ideas ──

export async function fetchContentIdeas(contentType: ContentType): Promise<{ ideas: ContentIdea[] }> {
  const res = await fetch(API_BASE + '/api/content-ideas?contentType=' + contentType, {
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}

export async function generateContentIdeas(contentType: ContentType): Promise<{ ideas: ContentIdea[] }> {
  const res = await fetch(API_BASE + '/api/content-ideas/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ contentType }),
  });
  return handleResponseWithToast(res);
}

export async function useContentIdea(ideaId: string): Promise<{ idea: ContentIdea }> {
  const res = await fetch(API_BASE + '/api/content-ideas/' + ideaId + '/use', {
    method: 'POST',
    headers: { ...authHeaders() },
  });
  return handleResponseWithToast(res);
}

export async function dismissContentIdea(ideaId: string): Promise<{ success: boolean }> {
  const res = await fetch(API_BASE + '/api/content-ideas/' + ideaId, {
    method: 'DELETE',
    headers: { ...authHeaders() },
  });
  return handleResponseWithToast(res);
}

// ── Quote Generation ──

export async function generateQuote(data: {
  customerText?: string;
  mediaItemIds?: string[];
  jobberRequestId?: string;
  manualRequestId?: string;
}): Promise<QuoteDraft> {
  const res = await fetch(API_BASE + '/api/quotes/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  });
  return handleResponseWithToast(res);
}

export async function fetchDrafts(): Promise<QuoteDraft[]> {
  const res = await fetch(API_BASE + '/api/quotes/drafts', {
    headers: { ...authHeaders() },
  });
  const data = await handleResponse<{ drafts: QuoteDraft[] }>(res);
  return data.drafts;
}

export async function fetchDraft(id: string): Promise<QuoteDraft> {
  const res = await fetch(API_BASE + '/api/quotes/drafts/' + id, {
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}

export async function updateDraft(id: string, updates: QuoteDraftUpdate): Promise<QuoteDraft> {
  const res = await fetch(API_BASE + '/api/quotes/drafts/' + id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(updates),
  });
  return handleResponseWithToast(res);
}

export async function patchDraftSqft(id: string, sqftOverride: number | null): Promise<QuoteDraft> {
  const res = await fetch(API_BASE + '/api/quotes/drafts/' + id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ sqftOverride }),
  });
  return handleResponseWithToast(res);
}

export async function reviseDraft(
  draftId: string,
  feedbackText: string,
  createRule?: boolean,
): Promise<QuoteDraft & { ruleCreated?: { id: string; name: string }; ruleCreationError?: string }> {
  const res = await fetch(API_BASE + '/api/quotes/drafts/' + draftId + '/revise', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ feedbackText, ...(createRule ? { createRule: true } : {}) }),
  });
  return handleResponseWithToast(res);
}

export async function deleteDraft(id: string): Promise<void> {
  const res = await fetch(API_BASE + '/api/quotes/drafts/' + id, {
    method: 'DELETE',
    headers: { ...authHeaders() },
  });
  await handleResponseWithToast(res);
}

export async function fetchCatalog(): Promise<ProductCatalogEntry[]> {
  const res = await fetch(API_BASE + '/api/quotes/catalog', {
    headers: { ...authHeaders() },
  });
  const data = await handleResponse<{ catalog: ProductCatalogEntry[] }>(res);
  return data.catalog;
}

export async function saveCatalog(
  entries: Array<{ name: string; unitPrice: number; description: string; category?: string }>,
): Promise<ProductCatalogEntry[]> {
  const res = await fetch(API_BASE + '/api/quotes/catalog', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ entries }),
  });
  const data = await handleResponseWithToast<{ catalog: ProductCatalogEntry[] }>(res);
  return data.catalog;
}

export async function updateCatalogEntry(
  entryId: string,
  updates: { name?: string; description?: string },
): Promise<void> {
  const res = await fetch(API_BASE + '/api/quotes/catalog/' + entryId, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(updates),
  });
  await handleResponseWithToast(res);
}

export async function reorderCatalog(
  orderedIds: string[],
): Promise<ProductCatalogEntry[]> {
  const res = await fetch(API_BASE + '/api/quotes/catalog/reorder', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ orderedIds }),
  });
  const data = await handleResponseWithToast<{ catalog: ProductCatalogEntry[] }>(res);
  return data.catalog;
}

export async function fetchTemplates(): Promise<QuoteTemplate[]> {
  const res = await fetch(API_BASE + '/api/quotes/templates', {
    headers: { ...authHeaders() },
  });
  const data = await handleResponse<{ templates: QuoteTemplate[] }>(res);
  return data.templates;
}

export async function saveTemplates(
  entries: Array<{ name: string; content: string; category?: string; lineItems?: Array<{ name: string; description: string; quantity: number; unitPrice: number }> }>,
): Promise<QuoteTemplate[]> {
  const res = await fetch(API_BASE + '/api/quotes/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ entries }),
  });
  const data = await handleResponseWithToast<{ templates: QuoteTemplate[] }>(res);
  return data.templates;
}

export async function saveTemplateFromDraft(
  draftId: string,
  name: string,
  category?: string,
): Promise<{ template: QuoteTemplate; templates: QuoteTemplate[] }> {
  const res = await fetch(API_BASE + '/api/quotes/templates/from-draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ draftId, name, category }),
  });
  return handleResponseWithToast(res);
}

export async function deleteTemplate(templateId: string): Promise<QuoteTemplate[]> {
  const res = await fetch(API_BASE + '/api/quotes/templates/' + templateId, {
    method: 'DELETE',
    headers: { ...authHeaders() },
  });
  const data = await handleResponseWithToast<{ templates: QuoteTemplate[] }>(res);
  return data.templates;
}

export async function checkJobberStatus(): Promise<boolean> {
  const res = await fetch(API_BASE + '/api/quotes/jobber/status', {
    headers: { ...authHeaders() },
  });
  const data = await handleResponse<{ available: boolean }>(res);
  return data.available;
}

export async function fetchJobberRequests(opts?: { fresh?: boolean }): Promise<{ requests: JobberCustomerRequest[]; available: boolean }> {
  const url = opts?.fresh
    ? API_BASE + '/api/quotes/jobber/requests?fresh=true'
    : API_BASE + '/api/quotes/jobber/requests';
  const res = await fetch(url, {
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}

export async function fetchJobberRequestFormData(requestId: string): Promise<{ formData: JobberRequestFormData | null }> {
  const res = await fetch(API_BASE + '/api/quotes/jobber/requests/' + requestId + '/form-data', {
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}

export interface JobberRequestDetail {
  id: string;
  title: string;
  clientName: string;
  description: string;
  imageUrls: string[];
  notes: Array<{ message: string; createdBy: string; createdAt: string }>;
  propertyAddress: string | null;
}

export async function fetchJobberRequestDetail(requestId: string): Promise<{ request: JobberRequestDetail | null }> {
  const res = await fetch(API_BASE + '/api/quotes/jobber/requests/' + requestId, {
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}

// ── Quote Corpus ──

export interface SyncResult {
  totalFetched: number;
  newQuotes: number;
  updatedQuotes: number;
  unchangedQuotes: number;
  embeddingsGenerated: number;
  durationMs: number;
  error?: string;
}

export async function syncCorpus(): Promise<SyncResult> {
  const res = await fetch(API_BASE + '/api/quotes/corpus/sync', {
    method: 'POST',
    headers: { ...authHeaders() },
  });
  return handleResponseWithToast(res);
}

export async function fetchCorpusStatus(): Promise<{ totalQuotes: number; lastSyncAt: string | null }> {
  const res = await fetch(API_BASE + '/api/quotes/corpus/status', {
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}


// ── Manual Requests ──

export async function createManualRequest(payload: CreateManualRequestPayload): Promise<ManualRequest> {
  const res = await fetch(API_BASE + '/api/quotes/manual-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return handleResponseWithToast(res);
}

export async function fetchManualRequest(id: string): Promise<ManualRequest> {
  const res = await fetch(API_BASE + '/api/quotes/manual-requests/' + id, {
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}

export async function fetchManualRequests(sortBy?: 'age_asc' | 'age_desc'): Promise<ManualRequestWithDeathclock[]> {
  const params = new URLSearchParams({ include_deathclock: 'true' });
  if (sortBy) params.set('sort_by', sortBy);
  const res = await fetch(API_BASE + '/api/quotes/manual-requests?' + params.toString(), {
    headers: { ...authHeaders() },
  });
  const data = await handleResponse<{ requests: ManualRequestWithDeathclock[] }>(res);
  return data.requests;
}

export async function fetchDraftManualRequest(draftId: string): Promise<ManualRequest | null> {
  const res = await fetch(API_BASE + '/api/quotes/drafts/' + draftId + '/manual-request', {
    headers: { ...authHeaders() },
  });
  const data = await handleResponse<{ manualRequest: ManualRequest | null }>(res);
  return data?.manualRequest ?? null;
}

export async function fetchDeathclock(requestId: string): Promise<DeathclockState> {
  const res = await fetch(API_BASE + '/api/quotes/manual-requests/' + requestId + '/deathclock', {
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}

// ── Rules Engine ──

export async function fetchRules(): Promise<RuleGroupWithRules[]> {
  const res = await fetch(API_BASE + '/api/quotes/rules', {
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}

export async function createRule(data: {
  name: string;
  description: string;
  ruleGroupId?: string;
  isActive?: boolean;
  conditionJson?: RuleCondition;
  actionJson?: RuleAction[];
  triggerMode?: TriggerMode;
}): Promise<Rule> {
  const res = await fetch(API_BASE + '/api/quotes/rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  });
  return handleResponseWithToast(res);
}

export async function updateRule(id: string, data: {
  name?: string;
  description?: string;
  ruleGroupId?: string;
  isActive?: boolean;
  conditionJson?: RuleCondition | null;
  actionJson?: RuleAction[] | null;
  triggerMode?: TriggerMode;
}): Promise<Rule> {
  const res = await fetch(API_BASE + '/api/quotes/rules/' + id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  });
  return handleResponseWithToast(res);
}

export async function deactivateRule(id: string): Promise<Rule> {
  const res = await fetch(API_BASE + '/api/quotes/rules/' + id + '/deactivate', {
    method: 'PUT',
    headers: { ...authHeaders() },
  });
  return handleResponseWithToast(res);
}

export async function createRuleGroup(data: {
  name: string;
  description?: string;
}): Promise<RuleGroup> {
  const res = await fetch(API_BASE + '/api/quotes/rules/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  });
  return handleResponseWithToast(res);
}

export async function updateRuleGroup(id: string, data: {
  name?: string;
  description?: string;
  displayOrder?: number;
}): Promise<RuleGroup> {
  const res = await fetch(API_BASE + '/api/quotes/rules/groups/' + id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  });
  return handleResponseWithToast(res);
}

export async function deleteRuleGroup(id: string): Promise<void> {
  const res = await fetch(API_BASE + '/api/quotes/rules/groups/' + id, {
    method: 'DELETE',
    headers: { ...authHeaders() },
  });
  await handleResponseWithToast(res);
}

export async function summarizeRuleTitle(description: string): Promise<string> {
  const res = await fetch(API_BASE + '/api/quotes/rules/summarize-title', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ description }),
  });
  const data = await handleResponse<{ title: string }>(res);
  return data.title;
}

export async function regenerateRuleTitles(): Promise<{ updated: number; total: number }> {
  const res = await fetch(API_BASE + '/api/quotes/rules/regenerate-titles', {
    method: 'POST',
    headers: { ...authHeaders() },
  });
  return handleResponseWithToast(res);
}

export async function autoCategorizeRules(): Promise<{ moved: number; total: number }> {
  const res = await fetch(API_BASE + '/api/quotes/rules/auto-categorize', {
    method: 'POST',
    headers: { ...authHeaders() },
  });
  return handleResponseWithToast(res);
}

// ── Push to Jobber ──

export async function pushDraftToJobber(draftId: string): Promise<{ jobberQuoteId: string; jobberQuoteNumber: string; jobberQuoteWebUri: string }> {
  const res = await fetch(API_BASE + '/api/quotes/drafts/' + draftId + '/push', {
    method: 'POST',
    headers: { ...authHeaders() },
  });
  return handleResponseWithToast(res);
}

// ── Extraction Presets ──

export interface ExtractionPreset {
  id: string;
  name: string;
  description: string;
  pattern: string;
  variableName: string;
  exampleMatches: string[];
}

export async function fetchExtractionPresets(): Promise<ExtractionPreset[]> {
  const res = await fetch(API_BASE + '/api/quotes/rules/extraction-presets', {
    headers: { ...authHeaders() },
  });
  const data = await handleResponse<{ presets: ExtractionPreset[] }>(res);
  return data.presets;
}

// ── Productivity Rates ──

export async function fetchProductivityRates(): Promise<ProductivityRate[]> {
  const res = await fetch(API_BASE + '/api/quotes/productivity-rates', {
    headers: { ...authHeaders() },
  });
  const data = await handleResponse<{ rates: ProductivityRate[] }>(res);
  return data.rates;
}

export async function updateProductivityRate(
  id: string,
  payload: UpdateProductivityRatePayload,
): Promise<ProductivityRate> {
  const res = await fetch(API_BASE + '/api/quotes/productivity-rates/' + id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return handleResponseWithToast(res);
}

// ── Deathclock Dashboard ──

export interface DeathclockBucketCounts {
  green: number;
  yellow: number;
  orange: number;
  red: number;
  totalActive: number;
}

export async function fetchDeathclockStats(): Promise<DeathclockBucketCounts> {
  const res = await fetch(API_BASE + '/api/dashboard/deathclock-stats', {
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}

export interface BucketHistoryEntry {
  date: string;
  green: number;
  yellow: number;
  orange: number;
  red: number;
}

export interface DeathclockTrends {
  avg7Days: number;
  avg30Days: number;
  bucketHistory: BucketHistoryEntry[];
}

export async function fetchTrends(): Promise<DeathclockTrends> {
  const res = await fetch(API_BASE + '/api/dashboard/trends', {
    headers: { ...authHeaders() },
  });
  return handleResponse(res);
}
