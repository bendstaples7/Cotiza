import { Hono } from 'hono';
import type { Bindings } from '../bindings.js';
import type { User } from 'shared';
import { sessionMiddleware } from '../middleware/session.js';
import { PlatformError } from '../errors/index.js';
import { ReviewService } from '../services/review-service.js';
import { QuoteDraftService } from '../services/quote-draft-service.js';
import { ReviewSnapshotService } from '../services/review-snapshot-service.js';
import { ActivityLogService } from '../services/activity-log-service.js';

const app = new Hono<{ Bindings: Bindings; Variables: { user: User } }>();

app.use('*', sessionMiddleware);

/**
 * Helper to create JobberIntegration for push operations.
 * Injected lazily since it requires async token loading.
 */
async function createJobberIntegration(db: D1Database, env: Bindings) {
  const { JobberIntegration } = await import('../services/jobber-integration.js');
  const { JobberTokenStore } = await import('../services/jobber-token-store.js');
  const activityLog = new ActivityLogService(db);
  const tokenStore = new JobberTokenStore(db);
  const jobberIntegration = new JobberIntegration(activityLog, {
    clientId: env.JOBBER_CLIENT_ID || '',
    clientSecret: env.JOBBER_CLIENT_SECRET || '',
    accessToken: env.JOBBER_ACCESS_TOKEN || '',
    refreshToken: env.JOBBER_REFRESH_TOKEN || '',
    apiUrl: env.JOBBER_API_URL || undefined,
    tokenStore,
  });
  await jobberIntegration.loadPersistedTokens();
  return jobberIntegration;
}

/**
 * POST /api/quotes/:id/submit-review
 * Submit a quote draft for review.
 */
app.post('/quotes/:id/submit-review', async (c) => {
  const userId = c.get('user').id;
  const draftId = c.req.param('id');
  const db = c.env.DB;

  const quoteDraftService = new QuoteDraftService(db);
  const draft = await quoteDraftService.getById(draftId, userId);

  const reviewService = new ReviewService(db);
  const result = await reviewService.submitForReview(
    draftId,
    userId,
    userId, // Self-review: submitter is also the reviewer
    [...draft.lineItems, ...draft.unresolvedItems],
    draft.customerNote,
    draft.depositSchedule,
  );

  // Log activity
  const activityLog = new ActivityLogService(db);
  await activityLog.log({
    userId,
    component: 'ReviewService',
    operation: 'review_submitted',
    severity: 'info',
    description: `Quote D-${String(draft.draftNumber).padStart(3, '0')} submitted for review`,
    recommendedAction: undefined,
  });

  return c.json(result);
});

/**
 * POST /api/quotes/:id/re-submit
 * Re-submit a quote for review after changes.
 */
app.post('/quotes/:id/re-submit', async (c) => {
  const userId = c.get('user').id;
  const draftId = c.req.param('id');
  const db = c.env.DB;

  const quoteDraftService = new QuoteDraftService(db);
  const draft = await quoteDraftService.getById(draftId, userId);

  const reviewService = new ReviewService(db);
  const result = await reviewService.reSubmitForReview(
    draftId,
    userId,
    userId,
    [...draft.lineItems, ...draft.unresolvedItems],
    draft.customerNote,
    draft.depositSchedule,
  );

  const activityLog = new ActivityLogService(db);
  await activityLog.log({
    userId,
    component: 'ReviewService',
    operation: 'review_submitted',
    severity: 'info',
    description: `Quote D-${String(draft.draftNumber).padStart(3, '0')} re-submitted for review (cycle ${result.reviewCycle})`,
    recommendedAction: undefined,
  });

  return c.json(result);
});

/**
 * GET /api/reviews/pending
 * Get the pending review queue.
 */
app.get('/reviews/pending', async (c) => {
  const db = c.env.DB;
  const reviewService = new ReviewService(db);

  // Get all pending reviews with draft info
  const result = await db.prepare(
    `SELECT qr.id, qr.quote_draft_id, qd.draft_number, qd.customer_request_text,
            qr.status, qr.submitted_at, qr.review_cycle, qr.submitted_by_id,
            (SELECT SUM(li.quantity * li.unit_price) FROM quote_line_items li WHERE li.quote_draft_id = qd.id AND li.resolved = 1) as total_value,
            u.display_name as submitted_by_name
     FROM quote_reviews qr
     JOIN quote_drafts qd ON qd.id = qr.quote_draft_id
     LEFT JOIN users u ON u.id = qr.submitted_by_id
     WHERE qr.status = 'pending_review'
     ORDER BY qr.submitted_at ASC`
  ).all();

  const reviews = (result.results as any[]).map((row) => ({
    id: row.id as string,
    quoteDraftId: row.quote_draft_id as string,
    draftNumber: (row.draft_number as number) ?? 0,
    totalValue: Number(row.total_value ?? 0),
    status: row.status as string,
    submittedAt: row.submitted_at as string,
    reviewCycle: (row.review_cycle as number) ?? 1,
    submittedBy: {
      id: row.submitted_by_id as string,
      name: (row.submitted_by_name as string) ?? 'Unknown',
    },
  }));

  return c.json({ reviews });
});

/**
 * GET /api/reviews/:id
 * Get review detail with feedback and snapshots.
 */
app.get('/reviews/:id', async (c) => {
  const db = c.env.DB;
  const reviewId = c.req.param('id');

  const reviewService = new ReviewService(db);
  const reviewDetail = await reviewService.getReview(reviewId);

  if (!reviewDetail) {
    throw new PlatformError({
      severity: 'error',
      component: 'ReviewRoutes',
      operation: 'getReview',
      description: 'Review not found.',
      recommendedActions: ['Verify the review ID'],
      statusCode: 404,
    });
  }

  // Get full quote draft
  const quoteDraftService = new QuoteDraftService(db);
  try {
    // Try to get the draft — may fail if user doesn't own it, but we still want to return the review detail
    reviewDetail.quote = await quoteDraftService.getById(reviewDetail.review.quoteDraftId, c.get('user').id);
  } catch {
    // Draft access may fail — return partial data
  }

  return c.json(reviewDetail);
});

/**
 * POST /api/reviews/:id/feedback
 * Add line-item feedback to a review.
 */
app.post('/reviews/:id/feedback', async (c) => {
  const userId = c.get('user').id;
  const reviewId = c.req.param('id');
  const db = c.env.DB;

  const body = await c.req.json() as {
    type?: 'line_item' | 'quote_level';
    lineItemId?: string;
    fieldName?: string;
    content: string;
  };

  if (!body.content || body.content.trim() === '') {
    throw new PlatformError({
      severity: 'error',
      component: 'ReviewRoutes',
      operation: 'addFeedback',
      description: 'Feedback content is required.',
      recommendedActions: ['Provide non-empty content for the feedback'],
      statusCode: 400,
    });
  }

  const fieldName = body.fieldName ?? 'general';
  const lineItemId = body.lineItemId ?? '';

  const reviewService = new ReviewService(db);
  const result = await reviewService.addFeedback(reviewId, lineItemId, fieldName, body.content, userId);

  return c.json({ feedbackId: result.feedbackId, createdAt: result.createdAt });
});

/**
 * POST /api/reviews/:id/complete
 * Complete a review with an outcome (push_to_jobber or changes_requested).
 */
app.post('/reviews/:id/complete', async (c) => {
  const userId = c.get('user').id;
  const reviewId = c.req.param('id');
  const db = c.env.DB;

  const body = await c.req.json() as {
    outcome: 'push_to_jobber' | 'changes_requested';
    quoteLevelComments?: string;
  };

  if (!body.outcome || !['push_to_jobber', 'changes_requested'].includes(body.outcome)) {
    throw new PlatformError({
      severity: 'error',
      component: 'ReviewRoutes',
      operation: 'completeReview',
      description: 'Invalid outcome. Must be "push_to_jobber" or "changes_requested".',
      recommendedActions: ['Provide a valid outcome value'],
      statusCode: 400,
    });
  }

  const reviewService = new ReviewService(db);

  let jobberIntegration;
  if (body.outcome === 'push_to_jobber') {
    jobberIntegration = await createJobberIntegration(db, c.env);
  }

  const result = await reviewService.completeReview(
    reviewId,
    body.outcome,
    body.quoteLevelComments ?? null,
    jobberIntegration,
  );

  // Get draft info for logging
  const reviewRow = await db.prepare(
    'SELECT qd.draft_number, qr.quote_draft_id FROM quote_reviews qr JOIN quote_drafts qd ON qd.id = qr.quote_draft_id WHERE qr.id = ?'
  ).bind(reviewId).first() as { draft_number: number; quote_draft_id: string } | null;

  const activityLog = new ActivityLogService(db);
  const draftNum = reviewRow ? `D-${String(reviewRow.draft_number).padStart(3, '0')}` : 'Unknown';

  if (body.outcome === 'changes_requested') {
    await activityLog.log({
      userId,
      component: 'ReviewService',
      operation: 'changes_requested',
      severity: 'info',
      description: `Changes requested on Quote ${draftNum}`,
      recommendedAction: undefined,
    });
  } else {
    await activityLog.log({
      userId,
      component: 'ReviewService',
      operation: 'pushed_to_jobber',
      severity: 'info',
      description: `Quote ${draftNum} was pushed to Jobber`,
      recommendedAction: undefined,
    });
  }

  return c.json(result);
});

/**
 * POST /api/reviews/:id/push
 * Push a reviewed quote to Jobber.
 */
app.post('/reviews/:id/push', async (c) => {
  const reviewId = c.req.param('id');
  const db = c.env.DB;

  const jobberIntegration = await createJobberIntegration(db, c.env);
  const reviewService = new ReviewService(db);
  const result = await reviewService.pushToJobber(reviewId, jobberIntegration);

  const activityLog = new ActivityLogService(db);
  await activityLog.log({
    userId: c.get('user').id,
    component: 'ReviewService',
    operation: 'pushed_to_jobber',
    severity: 'info',
    description: `Review cycle pushed quote to Jobber (quote ${result.jobberQuoteNumber})`,
    recommendedAction: undefined,
  });

  return c.json(result);
});

/**
 * GET /api/reviews/:id/diff
 * Get the diff between the current quote state and the latest snapshot.
 */
app.get('/reviews/:id/diff', async (c) => {
  const reviewId = c.req.param('id');
  const db = c.env.DB;

  const reviewService = new ReviewService(db);
  const diff = await reviewService.getDiff(reviewId);

  if (!diff) {
    throw new PlatformError({
      severity: 'error',
      component: 'ReviewRoutes',
      operation: 'getDiff',
      description: 'Could not compute diff. Review or snapshot not found.',
      recommendedActions: ['Verify the review ID and that a snapshot exists'],
      statusCode: 404,
    });
  }

  return c.json(diff);
});

export default app;