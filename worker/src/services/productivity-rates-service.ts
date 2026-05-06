import { PlatformError } from '../errors/index.js';
import type { ProductivityRate, UpdateProductivityRatePayload } from 'shared';

export class ProductivityRatesService {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /** Return all rates ordered by display_name ascending. */
  async getAllRates(): Promise<ProductivityRate[]> {
    const result = await this.db.prepare(
      'SELECT * FROM productivity_rates ORDER BY display_name ASC'
    ).all();

    return (result.results as Record<string, unknown>[]).map((row) => this.mapRow(row));
  }

  /** Return a single rate by id, or throw 404 PlatformError. */
  async getRateById(id: string): Promise<ProductivityRate> {
    const row = await this.db.prepare(
      'SELECT * FROM productivity_rates WHERE id = ?'
    ).bind(id).first() as Record<string, unknown> | null;

    if (!row) {
      throw new PlatformError({
        severity: 'error',
        component: 'ProductivityRatesService',
        operation: 'getRateById',
        description: `Productivity rate with id "${id}" not found.`,
        recommendedActions: ['Refresh the page to reload the current rates'],
        statusCode: 404,
      });
    }

    return this.mapRow(row);
  }

  /**
   * Update sqft_per_hour, display_name, and/or description for an existing rate.
   * Validates sqft_per_hour is a finite positive number.
   * Returns the updated rate.
   */
  async updateRate(id: string, payload: UpdateProductivityRatePayload): Promise<ProductivityRate> {
    this.validateSqftPerHour(payload.sqftPerHour);

    if (payload.displayName !== undefined && payload.displayName.trim() === '') {
      throw new PlatformError({
        severity: 'error',
        component: 'ProductivityRatesService',
        operation: 'updateRate',
        description: 'display_name must be a non-empty string.',
        recommendedActions: ['Provide a non-empty display name'],
        statusCode: 400,
      });
    }

    const setClauses: string[] = ["sqft_per_hour = ?", "updated_at = datetime('now')"];
    const values: unknown[] = [payload.sqftPerHour];

    if (payload.displayName !== undefined) {
      setClauses.push('display_name = ?');
      values.push(payload.displayName.trim());
    }

    if (payload.description !== undefined) {
      setClauses.push('description = ?');
      values.push(payload.description);
    }

    values.push(id);

    await this.db.prepare(
      `UPDATE productivity_rates SET ${setClauses.join(', ')} WHERE id = ?`
    ).bind(...values).run();

    return this.getRateById(id);
  }

  /** Map a raw D1 row to a ProductivityRate. */
  private mapRow(row: Record<string, unknown>): ProductivityRate {
    return {
      id: row.id as string,
      variableName: row.variable_name as string,
      displayName: row.display_name as string,
      sqftPerHour: Number(row.sqft_per_hour),
      description: (row.description ?? null) as string | null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  /** Validate sqft_per_hour is a finite positive number. */
  private validateSqftPerHour(value: number): void {
    if (!Number.isFinite(value) || value <= 0) {
      throw new PlatformError({
        severity: 'error',
        component: 'ProductivityRatesService',
        operation: 'updateRate',
        description: 'sqft_per_hour must be a finite positive number greater than zero.',
        recommendedActions: ['Enter a positive number such as 40'],
        statusCode: 400,
      });
    }
  }
}
