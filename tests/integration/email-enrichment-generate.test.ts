/**
 * Integration Tests — Email context enrichment in POST /generate
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { User } from 'shared';
import { createMockD1 } from '../unit/helpers/mock-d1.js';
import type { MockD1Database } from '../unit/helpers/mock-d1.js';
import { errorHandler } from '../../worker/src/middleware/error-handler.js';
import quoteRoutes from '../../worker/src/routes/quotes.js';

const mockFetchContext = vi.hoisted(() => vi.fn<() => Promise<string>>());
const mockGenerateQuote = vi.hoisted(() => vi.fn());
const mockManualGetById = vi.hoisted(() => vi.fn());
const mockDraftSave = vi.hoisted(() => vi.fn());

vi.mock('../../worker/src/services/auth-service.js', () => ({
  AuthService: vi.fn().mockImplementation(() => ({
    verifySession: vi.fn().mockResolvedValue({
      id: 'user-test-001',
      email: 'test@chicago-reno.com',
      name: 'Test User',
      createdAt: new Date('2025-01-01T00:00:00Z'),
      lastActiveAt: new Date('2025-01-01T00:00:00Z'),
    }),
  })),
}));

vi.mock('../../worker/src/services/email-context-service.js', () => ({
  EmailContextService: vi.fn().mockImplementation(() => ({
    fetchContext: mockFetchContext,
  })),
}));

vi.mock('../../worker/src/services/quote-engine.js', () => ({
  QuoteEngine: vi.fn().mockImplementation(() => ({
    generateQuote: mockGenerateQuote,
  })),
}));

vi.mock('../../worker/src/services/manual-request-service.js', () => ({
  ManualRequestService: vi.fn().mockImplementation(() => ({
    getById: mockManualGetById,
  })),
}));

vi.mock('../../worker/src/services/quote-draft-service.js', () => ({
  QuoteDraftService: vi.fn().mockImplementation(() => ({
    save: mockDraftSave,
  })),
}));

vi.mock('../../worker/src/services/rules-service.js', () => ({
  RulesService: vi.fn().mockImplementation(() => ({
    getActiveStructuredRules: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../../worker/src/services/user-settings-service.js', () => ({
  UserSettingsService: vi.fn().mockImplementation(() => ({
    getSettings: vi.fn().mockResolvedValue({ materialPriceMode: false }),
  })),
}));

const TEST_USER: User = {
  id: 'user-test-001',
  email: 'test@chicago-reno.com',
  name: 'Test User',
  createdAt: new Date('2025-01-01T00:00:00Z'),
  lastActiveAt: new Date('2025-01-01T00:00:00Z'),
};

function createTestApp(db: MockD1Database): Hono {
  const testApp = new Hono();
  testApp.onError(errorHandler);
  testApp.use('*', async (c, next) => {
    c.env = {
      DB: db as unknown as D1Database,
      AI_TEXT_API_KEY: 'test-key',
      AI_TEXT_API_URL: 'https://api.openai.com/v1/chat/completions',
      GMAIL_CLIENT_ID: 'gmail-client',
      GMAIL_CLIENT_SECRET: 'gmail-secret',
      GMAIL_REFRESH_TOKEN: 'gmail-refresh',
    } as any;
    c.set('user', TEST_USER);
    await next();
  });
  testApp.route('/api/quotes', quoteRoutes);
  return testApp;
}

describe('POST /api/quotes/generate email enrichment', () => {
  let db: MockD1Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockD1();
    db.prepare.mockImplementation(() => {
      const stmt = {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [], success: true }),
        run: vi.fn().mockResolvedValue({ success: true, meta: {} }),
        raw: vi.fn().mockResolvedValue([]),
      };
      return stmt;
    });

    mockManualGetById.mockResolvedValue({
      id: 'mr-1',
      customerName: 'Jane Doe',
      customerEmail: 'jane@example.com',
      customerAddress: null,
    });

    mockFetchContext.mockResolvedValue('--- Email Conversation Context ---\nHi Jane');

    mockGenerateQuote.mockResolvedValue({
      draft: {
        id: 'draft-1',
        draftNumber: 1,
        userId: TEST_USER.id,
        customerRequestText: '',
        lineItems: [],
        unresolvedItems: [],
        status: 'draft',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    mockDraftSave.mockImplementation(async (draft: { id: string }) => ({
      ...draft,
      draftNumber: 1,
    }));
  });

  it('prepends email context to customerText for manual requests with customerEmail', async () => {
    const app = createTestApp(db);
    const res = await app.request('/api/quotes/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ manualRequestId: 'mr-1', customerText: 'Kitchen remodel' }),
    });

    expect(res.status).toBe(201);
    expect(mockFetchContext).toHaveBeenCalledWith('jane@example.com');
    expect(mockGenerateQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        customerText: expect.stringContaining('--- Email Conversation Context ---'),
      }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    const input = mockGenerateQuote.mock.calls[0][0];
    expect(input.customerText).toContain('Kitchen remodel');
  });

  it('continues quote generation when email enrichment returns empty', async () => {
    mockFetchContext.mockResolvedValue('');
    const app = createTestApp(db);
    const res = await app.request('/api/quotes/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ manualRequestId: 'mr-1', customerText: 'Bathroom update' }),
    });

    expect(res.status).toBe(201);
    expect(mockGenerateQuote).toHaveBeenCalledWith(
      expect.objectContaining({ customerText: 'Bathroom update' }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('prepends email context for Jobber requests using top-level email in webhook payload', async () => {
    db.prepare.mockImplementation((sql: string) => {
      const stmt = {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockImplementation(async () => {
          if (sql.includes('jobber_webhook_requests')) {
            return {
              request_body: JSON.stringify({ email: 'client@example.com', title: 'Kitchen job' }),
            };
          }
          return null;
        }),
        all: vi.fn().mockResolvedValue({ results: [], success: true }),
        run: vi.fn().mockResolvedValue({ success: true, meta: {} }),
        raw: vi.fn().mockResolvedValue([]),
      };
      return stmt;
    });

    const app = createTestApp(db);
    const res = await app.request('/api/quotes/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ jobberRequestId: 'jobber-req-1' }),
    });

    expect(res.status).toBe(201);
    expect(mockFetchContext).toHaveBeenCalledWith('client@example.com');
    expect(mockGenerateQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        customerText: expect.stringContaining('--- Email Conversation Context ---'),
      }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});
