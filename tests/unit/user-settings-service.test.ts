import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockD1, configurePrepareResults } from './helpers/mock-d1.js';
import type { MockD1Database } from './helpers/mock-d1.js';
import { UserSettingsService } from '../../worker/src/services/user-settings-service.js';
import { PlatformError } from '../../worker/src/errors/platform-error.js';
import { AdvisorMode } from 'shared';

describe('UserSettingsService', () => {
  let db: MockD1Database;
  let service: UserSettingsService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockD1();
    service = new UserSettingsService(db as unknown as D1Database);
  });

  describe('getSettings()', () => {
    it('returns user settings mapped from DB row', async () => {
      configurePrepareResults(db, [
        {
          first: {
            id: 'settings-1',
            user_id: 'user-1',
            advisor_mode: 'manual',
            approval_mode: 'manual_review',
            material_price_mode: 1,
            updated_at: '2024-06-01T00:00:00Z',
          },
        },
      ]);

      const settings = await service.getSettings('user-1');

      expect(settings.id).toBe('settings-1');
      expect(settings.userId).toBe('user-1');
      expect(settings.advisorMode).toBe(AdvisorMode.Manual);
      expect(settings.approvalMode).toBe('manual_review');
      expect(settings.materialPriceMode).toBe(true);
      expect(settings.updatedAt).toBeInstanceOf(Date);
    });

    it('maps material_price_mode 0 to false', async () => {
      configurePrepareResults(db, [
        {
          first: {
            id: 'settings-1',
            user_id: 'user-1',
            advisor_mode: 'manual',
            approval_mode: 'manual_review',
            material_price_mode: 0,
            updated_at: '2024-06-01T00:00:00Z',
          },
        },
      ]);

      const settings = await service.getSettings('user-1');
      expect(settings.materialPriceMode).toBe(false);
    });

    it('throws PlatformError when settings not found', async () => {
      configurePrepareResults(db, [{ first: null }]);

      await expect(service.getSettings('nonexistent')).rejects.toThrow(PlatformError);
      configurePrepareResults(db, [{ first: null }]);
      await expect(service.getSettings('nonexistent')).rejects.toThrow('User settings not found');
    });
  });

  describe('updateSettings()', () => {
    it('updates advisor_mode successfully', async () => {
      // UPDATE run, then SELECT first for result
      configurePrepareResults(db, [
        { run: { success: true } },
        {
          first: {
            id: 'settings-1',
            user_id: 'user-1',
            advisor_mode: 'smart',
            approval_mode: 'manual_review',
            material_price_mode: 0,
            updated_at: '2024-06-01T12:00:00Z',
          },
        },
      ]);

      const result = await service.updateSettings('user-1', { advisorMode: AdvisorMode.Smart });

      expect(result.advisorMode).toBe('smart');
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE user_settings'),
      );
    });

    it('updates approval_mode to manual_review', async () => {
      configurePrepareResults(db, [
        { run: { success: true } },
        {
          first: {
            id: 'settings-1',
            user_id: 'user-1',
            advisor_mode: 'manual',
            approval_mode: 'manual_review',
            material_price_mode: 0,
            updated_at: '2024-06-01T12:00:00Z',
          },
        },
      ]);

      const result = await service.updateSettings('user-1', { approvalMode: 'manual_review' });

      expect(result.approvalMode).toBe('manual_review');
    });

    it('blocks auto_publish mode with PlatformError', async () => {
      await expect(
        service.updateSettings('user-1', { approvalMode: 'auto_publish' }),
      ).rejects.toThrow(PlatformError);

      await expect(
        service.updateSettings('user-1', { approvalMode: 'auto_publish' }),
      ).rejects.toThrow('Auto-publish mode is not available in v1');

      // Should not have made any DB calls
      expect(db.prepare).not.toHaveBeenCalled();
    });

    it('rejects invalid advisor_mode', async () => {
      await expect(
        service.updateSettings('user-1', { advisorMode: 'invalid_mode' as AdvisorMode }),
      ).rejects.toThrow(PlatformError);

      await expect(
        service.updateSettings('user-1', { advisorMode: 'invalid_mode' as AdvisorMode }),
      ).rejects.toThrow('Invalid advisor mode');
    });

    it('returns current settings when no updates provided', async () => {
      configurePrepareResults(db, [
        {
          first: {
            id: 'settings-1',
            user_id: 'user-1',
            advisor_mode: 'manual',
            approval_mode: 'manual_review',
            material_price_mode: 0,
            updated_at: '2024-06-01T00:00:00Z',
          },
        },
      ]);

      const result = await service.updateSettings('user-1', {});

      expect(result.advisorMode).toBe('manual');
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('SELECT'),
      );
    });

    it('updates materialPriceMode to true', async () => {
      configurePrepareResults(db, [
        { run: { success: true } },
        {
          first: {
            id: 'settings-1',
            user_id: 'user-1',
            advisor_mode: 'manual',
            approval_mode: 'manual_review',
            material_price_mode: 1,
            updated_at: '2024-06-01T12:00:00Z',
          },
        },
      ]);

      const result = await service.updateSettings('user-1', { materialPriceMode: true });

      expect(result.materialPriceMode).toBe(true);
      // Verify the SQL includes material_price_mode in the SET clause
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('material_price_mode = ?'),
      );
    });

    it('updates materialPriceMode to false', async () => {
      configurePrepareResults(db, [
        { run: { success: true } },
        {
          first: {
            id: 'settings-1',
            user_id: 'user-1',
            advisor_mode: 'manual',
            approval_mode: 'manual_review',
            material_price_mode: 0,
            updated_at: '2024-06-01T12:00:00Z',
          },
        },
      ]);

      const result = await service.updateSettings('user-1', { materialPriceMode: false });

      expect(result.materialPriceMode).toBe(false);
    });

    it('updates multiple fields including materialPriceMode', async () => {
      configurePrepareResults(db, [
        { run: { success: true } },
        {
          first: {
            id: 'settings-1',
            user_id: 'user-1',
            advisor_mode: 'smart',
            approval_mode: 'manual_review',
            material_price_mode: 1,
            updated_at: '2024-06-01T12:00:00Z',
          },
        },
      ]);

      const result = await service.updateSettings('user-1', {
        advisorMode: AdvisorMode.Smart,
        materialPriceMode: true,
      });

      expect(result.advisorMode).toBe('smart');
      expect(result.materialPriceMode).toBe(true);
    });

    it('throws PlatformError when user settings row not found on update', async () => {
      configurePrepareResults(db, [
        { run: { success: true } },
        { first: null },
      ]);

      await expect(
        service.updateSettings('nonexistent', { advisorMode: AdvisorMode.Random }),
      ).rejects.toThrow(PlatformError);
    });
  });
});
