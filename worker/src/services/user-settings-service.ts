import { PlatformError } from '../errors/index.js';
import { AdvisorMode } from 'shared';
import type { UserSettings, ApprovalMode } from 'shared';

const VALID_ADVISOR_MODES = Object.values(AdvisorMode) as string[];
const VALID_APPROVAL_MODES = ['manual_review', 'auto_publish'];

export class UserSettingsService {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async getSettings(userId: string): Promise<UserSettings> {
    const row = await this.db.prepare(
      'SELECT id, user_id, advisor_mode, approval_mode, material_price_mode, updated_at FROM user_settings WHERE user_id = ?'
    ).bind(userId).first() as any;

    if (!row) {
      throw new PlatformError({
        severity: 'error',
        component: 'UserSettingsService',
        operation: 'getSettings',
        description: 'User settings not found. Please log in again to initialize your settings.',
        recommendedActions: ['Log out and log back in to create default settings'],
      });
    }

    return {
      id: row.id as string,
      userId: row.user_id as string,
      advisorMode: row.advisor_mode as AdvisorMode,
      approvalMode: row.approval_mode as ApprovalMode,
      materialPriceMode: row.material_price_mode === 1 || row.material_price_mode === true,
      updatedAt: new Date(row.updated_at as string),
    };
  }

  async updateSettings(
    userId: string,
    updates: { advisorMode?: AdvisorMode; approvalMode?: ApprovalMode; materialPriceMode?: boolean },
  ): Promise<UserSettings> {
    if (updates.approvalMode !== undefined) {
      if (!VALID_APPROVAL_MODES.includes(updates.approvalMode)) {
        throw new PlatformError({
          severity: 'error',
          component: 'UserSettingsService',
          operation: 'updateSettings',
          description: 'Invalid approval mode: "' + updates.approvalMode + '". Valid modes are: ' + VALID_APPROVAL_MODES.join(', ') + '.',
          recommendedActions: ['Select a valid approval mode'],
        });
      }
      if (updates.approvalMode === 'auto_publish') {
      throw new PlatformError({
        severity: 'error',
        component: 'UserSettingsService',
        operation: 'updateSettings',
        description: 'Auto-publish mode is not available in v1. All posts require manual review before publishing.',
        recommendedActions: ['Keep the approval mode set to manual review'],
      });
      }
    }

    if (updates.advisorMode !== undefined && !VALID_ADVISOR_MODES.includes(updates.advisorMode)) {
      throw new PlatformError({
        severity: 'error',
        component: 'UserSettingsService',
        operation: 'updateSettings',
        description: 'Invalid advisor mode: "' + updates.advisorMode + '". Valid modes are: ' + VALID_ADVISOR_MODES.join(', ') + '.',
        recommendedActions: ['Select a valid advisor mode: smart, random, or manual'],
      });
    }

    if (updates.materialPriceMode !== undefined && typeof updates.materialPriceMode !== 'boolean') {
      throw new PlatformError({
        severity: 'error',
        component: 'UserSettingsService',
        operation: 'updateSettings',
        description: 'materialPriceMode must be a boolean value.',
        recommendedActions: ['Provide true or false for materialPriceMode'],
      });
    }

    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.advisorMode !== undefined) {
      setClauses.push('advisor_mode = ?');
      params.push(updates.advisorMode);
    }

    if (updates.approvalMode !== undefined) {
      setClauses.push('approval_mode = ?');
      params.push(updates.approvalMode);
    }

    if (updates.materialPriceMode !== undefined) {
      setClauses.push('material_price_mode = ?');
      params.push(updates.materialPriceMode ? 1 : 0);
    }

    if (setClauses.length === 0) {
      return this.getSettings(userId);
    }

    setClauses.push("updated_at = datetime('now')");
    params.push(userId);

    await this.db.prepare(
      'UPDATE user_settings SET ' + setClauses.join(', ') + ' WHERE user_id = ?'
    ).bind(...params).run();

    const row = await this.db.prepare(
      'SELECT id, user_id, advisor_mode, approval_mode, material_price_mode, updated_at FROM user_settings WHERE user_id = ?'
    ).bind(userId).first() as any;

    if (!row) {
      throw new PlatformError({
        severity: 'error',
        component: 'UserSettingsService',
        operation: 'updateSettings',
        description: 'User settings not found. Please log in again to initialize your settings.',
        recommendedActions: ['Log out and log back in to create default settings'],
      });
    }

    return {
      id: row.id as string,
      userId: row.user_id as string,
      advisorMode: row.advisor_mode as AdvisorMode,
      approvalMode: row.approval_mode as ApprovalMode,
      materialPriceMode: row.material_price_mode === 1 || row.material_price_mode === true,
      updatedAt: new Date(row.updated_at as string),
    };
  }
}