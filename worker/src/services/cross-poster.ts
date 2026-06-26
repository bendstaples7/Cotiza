import { PlatformError } from '../errors/index.js';
import { isPermanentError } from '../utils/permanent-error.js';
import type {
  ChannelInterface,
  FormattedPost,
  PublishResult,
} from 'shared';
import type { PostService } from './post-service.js';
import type { PublishApprovalService } from './publish-approval-service.js';
import type { ActivityLogService } from './activity-log-service.js';

export type DelayFn = (ms: number) => Promise<void>;

const defaultDelay: DelayFn = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class CrossPoster {
  private readonly db: D1Database;
  private readonly postService: PostService;
  private readonly approvalService: PublishApprovalService;
  private readonly channel: ChannelInterface;
  private readonly activityLog: ActivityLogService;
  private readonly delayFn: DelayFn;

  constructor(deps: {
    db: D1Database;
    postService: PostService;
    approvalService: PublishApprovalService;
    channel: ChannelInterface;
    activityLog: ActivityLogService;
    delayFn?: DelayFn;
  }) {
    this.db = deps.db;
    this.postService = deps.postService;
    this.approvalService = deps.approvalService;
    this.channel = deps.channel;
    this.activityLog = deps.activityLog;
    this.delayFn = deps.delayFn ?? defaultDelay;
  }

  /**
   * Publish a post to its target channel.
   * 1. Verify post is approved via PublishApprovalService
   * 2. Transition post to 'publishing'
   * 3. Format the post via channel.formatPost()
   * 4. Publish via channel.publish() with retry
   * 5. Update post status and log result
   */
  async publish(postId: string, userId: string): Promise<PublishResult> {
    // 1. Get the post
    const post = await this.postService.getById(postId, userId);

    // 2. Atomically check approval and transition to 'publishing'
    const transitioned = await this.approvalService.markPublishingIfApproved(postId, userId);
    if (!transitioned) {
      throw new PlatformError({
        severity: 'error',
        component: 'CrossPoster',
        operation: 'publish',
        description:
          'This post has not been approved for publishing. Please approve the post first.',
        recommendedActions: ['Approve the post before publishing'],
      });
    }

    // 3. Format the post for the channel. If formatting throws, revert the
    //    'publishing' transition so the post doesn't get stuck mid-flight.
    let formattedPost: FormattedPost;
    try {
      formattedPost = await this.channel.formatPost(post);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown error';
      await this.postService.transitionStatus(postId, userId, 'failed');
      await this.activityLog.log({
        userId,
        component: 'CrossPoster',
        operation: 'publish',
        severity: 'error',
        description: 'Post ' + postId + ' failed while preparing media: ' + reason,
        recommendedAction: 'Check the attached media and try again',
      });
      throw new PlatformError({
        severity: 'error',
        component: 'CrossPoster',
        operation: 'publish',
        description: 'Publishing failed while preparing the post: ' + reason,
        recommendedActions: [
          'Check the attached media and try again',
          'Verify the post content meets Instagram requirements',
        ],
      });
    }

    // 4. Attempt publish with retry
    const result = await this.publishWithRetry(formattedPost);

    // 5. Handle result
    if (result.success) {
      // Update external_post_id via PostService
      await this.postService.setExternalPostId(postId, userId, result.externalPostId!);

      // Transition to 'published'
      await this.postService.transitionStatus(postId, userId, 'published');

      // Log success
      await this.activityLog.log({
        userId,
        component: 'CrossPoster',
        operation: 'publish',
        severity: 'info',
        description: 'Post ' + postId + ' published successfully.',
      });

      return result;
    }

    // Publish failed after all retries
    await this.postService.transitionStatus(postId, userId, 'failed');

    await this.activityLog.log({
      userId,
      component: 'CrossPoster',
      operation: 'publish',
      severity: 'error',
      description: 'Post ' + postId + ' failed to publish after all retry attempts: ' + (result.error ?? 'Unknown error'),
      recommendedAction: 'Check your Instagram connection and try again',
    });

    throw new PlatformError({
      severity: 'error',
      component: 'CrossPoster',
      operation: 'publish',
      description: 'Publishing failed: ' + (result.error ?? 'Unknown error'),
      recommendedActions: [
        'Check your Instagram connection and try again',
        'Verify the post content meets Instagram requirements',
      ],
    });
  }

  /**
   * Retry logic: exponential backoff (1s, 2s, 4s).
   * After 3 retries (4 total attempts), return the last failure result.
   * Permanent errors (auth, invalid content) are not retried.
   */
  private async publishWithRetry(
    formattedPost: FormattedPost,
    maxRetries: number = 3,
  ): Promise<PublishResult> {
    let lastResult: PublishResult = { success: false, error: 'No attempts made' };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      lastResult = await this.channel.publish(formattedPost);

      if (lastResult.success) {
        return lastResult;
      }

      // Don't retry permanent errors
      if (isPermanentError(lastResult.error)) {
        return lastResult;
      }

      // Wait with exponential backoff before retrying (skip delay after last attempt)
      if (attempt < maxRetries) {
        const delayMs = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
        await this.delayFn(delayMs);
      }
    }

    return lastResult;
  }
}
