import { PlatformError } from '../errors/index.js';
import type { ManualRequest, CreateManualRequestPayload } from 'shared';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class ManualRequestService {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /**
   * Create and persist a manual request. Returns the saved record.
   */
  async create(userId: string, payload: CreateManualRequestPayload): Promise<ManualRequest> {
    this.validate(payload);

    const id = crypto.randomUUID();
    const customerName = payload.customerName.trim();
    const serviceDescription = payload.serviceDescription.trim();
    const customerPhone = payload.customerPhone?.trim() || null;
    const customerEmail = payload.customerEmail?.trim() || null;
    const customerAddress = payload.customerAddress?.trim() || null;
    const mediaItemIds = payload.mediaItemIds ?? [];
    const mediaItemIdsJson = JSON.stringify(mediaItemIds);

    try {
      await this.db.prepare(
        `INSERT INTO manual_requests (id, user_id, customer_name, customer_phone, customer_email, customer_address, service_description, media_item_ids_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        userId,
        customerName,
        customerPhone,
        customerEmail,
        customerAddress,
        serviceDescription,
        mediaItemIdsJson,
      ).run();
    } catch (err) {
      throw new PlatformError({
        severity: 'error',
        component: 'ManualRequestService',
        operation: 'create',
        description: 'Failed to save request. Please try again',
        recommendedActions: ['Try submitting the request again'],
        statusCode: 500,
      });
    }

    return {
      id,
      userId,
      customerName,
      customerPhone,
      customerEmail,
      customerAddress,
      serviceDescription,
      mediaItemIds,
      requestSource: 'manual',
      createdAt: new Date(),
    };
  }

  /**
   * Get a manual request by ID, scoped to user.
   */
  async getById(id: string, userId: string): Promise<ManualRequest> {
    const row = await this.db.prepare(
      'SELECT id, user_id, customer_name, customer_phone, customer_email, customer_address, service_description, media_item_ids_json, created_at FROM manual_requests WHERE id = ? AND user_id = ?'
    ).bind(id, userId).first() as Record<string, unknown> | null;

    if (!row) {
      throw new PlatformError({
        severity: 'error',
        component: 'ManualRequestService',
        operation: 'getById',
        description: 'Manual request not found',
        recommendedActions: ['Verify the request ID is correct'],
        statusCode: 404,
      });
    }

    return this.mapRow(row);
  }

  /**
   * Get a manual request by its associated quote draft ID.
   */
  async getByDraftId(draftId: string, userId: string): Promise<ManualRequest | null> {
    const row = await this.db.prepare(
      `SELECT mr.id, mr.user_id, mr.customer_name, mr.customer_phone, mr.customer_email, mr.customer_address, mr.service_description, mr.media_item_ids_json, mr.created_at
       FROM manual_requests mr
       JOIN quote_drafts qd ON qd.manual_request_id = mr.id
       WHERE qd.id = ? AND mr.user_id = ?`
    ).bind(draftId, userId).first() as Record<string, unknown> | null;

    if (!row) {
      return null;
    }

    return this.mapRow(row);
  }

  /**
   * Validate the create payload. Throws PlatformError on invalid input.
   */
  private validate(payload: CreateManualRequestPayload): void {
    // customerName: required, non-empty after trim, max 200 chars
    if (!payload.customerName || payload.customerName.trim().length === 0) {
      throw new PlatformError({
        severity: 'error',
        component: 'ManualRequestService',
        operation: 'create',
        description: 'Enter a customer name',
        recommendedActions: ['Provide a non-empty customer name'],
        statusCode: 400,
      });
    }
    if (payload.customerName.trim().length > 200) {
      throw new PlatformError({
        severity: 'error',
        component: 'ManualRequestService',
        operation: 'create',
        description: 'Customer name must be 200 characters or less',
        recommendedActions: ['Shorten the customer name to 200 characters or less'],
        statusCode: 400,
      });
    }

    // serviceDescription: required, non-empty after trim, max 10000 chars
    if (!payload.serviceDescription || payload.serviceDescription.trim().length === 0) {
      throw new PlatformError({
        severity: 'error',
        component: 'ManualRequestService',
        operation: 'create',
        description: 'Enter a service description',
        recommendedActions: ['Provide a non-empty service description'],
        statusCode: 400,
      });
    }
    if (payload.serviceDescription.trim().length > 10000) {
      throw new PlatformError({
        severity: 'error',
        component: 'ManualRequestService',
        operation: 'create',
        description: 'Service description must be 10,000 characters or less',
        recommendedActions: ['Shorten the service description to 10,000 characters or less'],
        statusCode: 400,
      });
    }

    // customerEmail: optional, basic email regex validation
    if (payload.customerEmail && payload.customerEmail.trim().length > 0) {
      if (!EMAIL_REGEX.test(payload.customerEmail.trim())) {
        throw new PlatformError({
          severity: 'error',
          component: 'ManualRequestService',
          operation: 'create',
          description: 'Enter a valid email address',
          recommendedActions: ['Provide a valid email address or leave the field empty'],
          statusCode: 400,
        });
      }
    }

    // customerPhone: optional, max 30 chars
    if (payload.customerPhone && payload.customerPhone.trim().length > 30) {
      throw new PlatformError({
        severity: 'error',
        component: 'ManualRequestService',
        operation: 'create',
        description: 'Phone number must be 30 characters or less',
        recommendedActions: ['Shorten the phone number to 30 characters or less'],
        statusCode: 400,
      });
    }

    // customerAddress: optional, max 500 chars
    if (payload.customerAddress && payload.customerAddress.trim().length > 500) {
      throw new PlatformError({
        severity: 'error',
        component: 'ManualRequestService',
        operation: 'create',
        description: 'Address must be 500 characters or less',
        recommendedActions: ['Shorten the address to 500 characters or less'],
        statusCode: 400,
      });
    }

    // mediaItemIds: optional array, max 10 items
    if (payload.mediaItemIds && payload.mediaItemIds.length > 10) {
      throw new PlatformError({
        severity: 'error',
        component: 'ManualRequestService',
        operation: 'create',
        description: 'Maximum 10 images allowed',
        recommendedActions: ['Remove some images to stay within the 10-image limit'],
        statusCode: 400,
      });
    }
  }

  /**
   * Map a database row to a ManualRequest object.
   */
  private mapRow(row: Record<string, unknown>): ManualRequest {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      customerName: row.customer_name as string,
      customerPhone: (row.customer_phone as string) || null,
      customerEmail: (row.customer_email as string) || null,
      customerAddress: (row.customer_address as string) || null,
      serviceDescription: row.service_description as string,
      mediaItemIds: JSON.parse((row.media_item_ids_json as string) || '[]'),
      requestSource: 'manual',
      createdAt: new Date(row.created_at as string),
    };
  }
}
