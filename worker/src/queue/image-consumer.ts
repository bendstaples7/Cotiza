import type { Bindings } from '../bindings.js';
import { ImageGenerator } from '../services/image-generator.js';
import { MediaService } from '../services/media-service.js';
import { isPermanentError } from '../utils/permanent-error.js';
import type { ImageGenerationRequest } from 'shared';

export { isPermanentError } from '../utils/permanent-error.js';

export interface ImageJobMessage {
  jobId: string;
  userId: string;
  request: ImageGenerationRequest;
}

export async function handleImageQueue(
  batch: MessageBatch<ImageJobMessage>,
  env: Bindings,
): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    const db = env.DB;
    const r2 = env.R2_BUCKET;

    // Update job status to processing
    await db.prepare(
      "UPDATE image_generation_jobs SET status = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind('processing', job.jobId).run();

    try {
      const imageGenerator = new ImageGenerator(env.AI_TEXT_API_KEY);
      const images = await imageGenerator.generate(job.request);

      // Store all generated images in R2 via MediaService
      const mediaService = new MediaService(db, r2);
      const mediaIds: string[] = [];
      for (const image of images) {
        const mediaItem = await mediaService.storeGenerated(image, job.userId);
        mediaIds.push(mediaItem.id);
      }

      // Update job as completed with all result media ids
      await db.prepare(
        "UPDATE image_generation_jobs SET status = ?, result_media_id = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind('completed', JSON.stringify(mediaIds), job.jobId).run();

      message.ack();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';

      if (isPermanentError(err)) {
        // Permanent failure — ack so it won't retry
        await db.prepare(
          "UPDATE image_generation_jobs SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?"
        ).bind('failed', errorMsg, job.jobId).run();
        message.ack();
      } else {
        // Transient failure — retry via the queue
        await db.prepare(
          "UPDATE image_generation_jobs SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?"
        ).bind('retrying', errorMsg, job.jobId).run();
        message.retry();
      }
    }
  }
}
