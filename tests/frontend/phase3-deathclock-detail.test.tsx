import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

// Lazy-loaded components (loaded after mocks are set up)
let QuoteDraftPage: React.ComponentType<Record<string, never>>;
let DeathclockDashboardPage: React.ComponentType<Record<string, never>>;

beforeAll(async () => {
  // Must be loaded after vi.mock hoisting takes effect
  const qdp = await import('../../client/src/pages/QuoteDraftPage');
  QuoteDraftPage = qdp.default;
  const ddp = await import('../../client/src/pages/DeathclockDashboardPage');
  DeathclockDashboardPage = ddp.default;
});

// ---------------------------------------------------------------------------
// Mock react-router-dom useParams and useNavigate
// ---------------------------------------------------------------------------
const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'test-draft-1' }),
    useNavigate: () => mockNavigate,
  };
});

// ---------------------------------------------------------------------------
// Mock API functions
// ---------------------------------------------------------------------------
type DeathclockState = {
  ageSeconds: number;
  ageLabel: string;
  color: 'green' | 'yellow' | 'orange' | 'red';
  isComplete: boolean;
  frozen: boolean;
  quoteCreationLagSeconds?: number;
  sendLagSeconds?: number;
  requestToQuoteSeconds?: number;
  sendEvents?: Array<{
    id: number;
    quoteId: string;
    requestId: string;
    sentAt: string;
    elapsedSecondsFromRequest: number;
    sendType: string;
  }>;
  siblingQuotes?: Array<{
    id: string;
    draftNumber: number;
    quoteSentAt: string | null;
    firstDraftCreatedAt: string | null;
    requestToQuoteSeconds: number | null;
  }>;
};

type QuoteDraft = {
  id: string;
  draftNumber: number;
  manualRequestId?: string | null;
  [key: string]: unknown;
};

const mockFetchDraft = vi.fn<(...args: unknown[]) => Promise<QuoteDraft>>();
const mockFetchDeathclock = vi.fn<(...args: unknown[]) => Promise<DeathclockState>>();
const mockFetchDeathclockStats = vi.fn<(...args: unknown[]) => Promise<Record<string, number>>>();
const mockFetchTrends = vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>();
const mockMarkRequestSent = vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>();

vi.mock('../../client/src/api', () => ({
  fetchDraft: mockFetchDraft,
  fetchDeathclock: mockFetchDeathclock,
  fetchDeathclockStats: mockFetchDeathclockStats,
  fetchTrends: mockFetchTrends,
  markRequestSent: mockMarkRequestSent,
  fetchRules: vi.fn().mockResolvedValue([]),
  fetchJobberRequestDetail: vi.fn().mockRejectedValue(new Error('not found')),
  fetchCatalog: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Type to match DeathclockBucketCounts from the API
// ---------------------------------------------------------------------------
type DeathclockBucketCounts = {
  green: number;
  yellow: number;
  orange: number;
  red: number;
  totalActive: number;
};

type BucketHistoryEntry = {
  date: string;
  green: number;
  yellow: number;
  orange: number;
  red: number;
};

type DeathclockTrends = {
  avg7Days: number;
  avg30Days: number;
  bucketHistory: BucketHistoryEntry[];
};

// ---------------------------------------------------------------------------
// Helpers — factory functions for test data
// ---------------------------------------------------------------------------

function makeDraft(overrides: Partial<QuoteDraft> = {}): QuoteDraft {
  return {
    id: 'test-draft-1',
    draftNumber: 42,
    manualRequestId: 'req-1',
    customerRequestText: 'Kitchen renovation',
    lineItems: [],
    unresolvedItems: [],
    status: 'draft',
    selectedTemplateId: null,
    selectedTemplateName: null,
    jobberRequestId: null,
    customerNote: null,
    depositSchedule: null,
    createdAt: new Date('2026-05-26').toISOString() as unknown as Date,
    updatedAt: new Date('2026-05-27').toISOString() as unknown as Date,
    ...overrides,
  };
}

function makeDeathclock(overrides: Partial<DeathclockState> = {}): DeathclockState {
  return {
    ageSeconds: 86400,
    ageLabel: '1.0d',
    color: 'yellow',
    isComplete: false,
    frozen: false,
    ...overrides,
  };
}

function makeStats(overrides: Partial<DeathclockBucketCounts> = {}): DeathclockBucketCounts {
  return {
    green: 10,
    yellow: 5,
    orange: 3,
    red: 2,
    totalActive: 20,
    ...overrides,
  };
}

function makeTrends(overrides: Partial<DeathclockTrends> = {}): DeathclockTrends {
  return {
    avg7Days: 43200,
    avg30Days: 86400,
    bucketHistory: [
      { date: '2026-05-21', green: 8, yellow: 3, orange: 1, red: 0 },
      { date: '2026-05-22', green: 7, yellow: 4, orange: 2, red: 1 },
      { date: '2026-05-23', green: 9, yellow: 2, orange: 0, red: 0 },
      { date: '2026-05-24', green: 6, yellow: 5, orange: 2, red: 1 },
      { date: '2026-05-25', green: 10, yellow: 3, orange: 1, red: 0 },
      { date: '2026-05-26', green: 8, yellow: 4, orange: 1, red: 2 },
      { date: '2026-05-27', green: 7, yellow: 3, orange: 2, red: 1 },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Renders
// ---------------------------------------------------------------------------

function renderDraftPage() {
  return render(
    <MemoryRouter initialEntries={['/quotes/drafts/test-draft-1']}>
      <QuoteDraftPage />
    </MemoryRouter>,
  );
}

function renderDashboardPage() {
  return render(
    <MemoryRouter initialEntries={['/quotes/deathclock-dashboard']}>
      <DeathclockDashboardPage />
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QuoteDraftPage — Phase 3 deathclock features', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // By default, fetchDraft resolves and fetchDeathclock resolves
    mockFetchDraft.mockResolvedValue(makeDraft());
    mockFetchDeathclock.mockResolvedValue(makeDeathclock());
  });

  // ── T3.1: Deathclock header ──

  it('renders DeathclockBadge in header when manualRequestId exists', async () => {
    renderDraftPage();

    await waitFor(() => {
      expect(screen.getByRole('status', { name: /Request age:/ })).toBeInTheDocument();
    });

    // Badge should show the deathclock age label
    const badge = screen.getByRole('status', { name: /Request age:/ });
    expect(badge).toHaveTextContent('1.0d');
  });

  it('left color strip matches deathclock color', async () => {
    mockFetchDeathclock.mockResolvedValue(makeDeathclock({ color: 'orange' }));
    const { container } = renderDraftPage();

    await waitFor(() => {
      expect(screen.getByRole('status', { name: /Request age:/ })).toBeInTheDocument();
    });

    // The header div has borderLeft set inline — find the h1 "Quote Draft D-042"
    const headerDiv = container.querySelector('[style*="border-left"]');
    expect(headerDiv).toBeInTheDocument();
    // orange maps to '#f97316' — browser converts to rgb()
    expect(headerDiv?.getAttribute('style')).toContain('rgb(249, 115, 22)');
  });

  it('badge uses non-compact mode (larger) in detail header', async () => {
    renderDraftPage();

    await waitFor(() => {
      expect(screen.getByRole('status', { name: /Request age:/ })).toBeInTheDocument();
    });

    // Non-compact badge has padding '2px 10px'
    const badge = screen.getByRole('status', { name: /Request age:/ });
    expect(badge.getAttribute('style')).toContain('2px 10px');
  });

  it('shows loading state while fetching deathclock', async () => {
    // Keep deathclock pending forever
    mockFetchDeathclock.mockReturnValue(new Promise<DeathclockState>(() => {}));
    renderDraftPage();

    await waitFor(() => {
      expect(screen.getByText('Loading deathclock...')).toBeInTheDocument();
    });
  });

  it('shows no deathclock when manualRequestId is null', async () => {
    mockFetchDraft.mockResolvedValue(makeDraft({ manualRequestId: null }));
    renderDraftPage();

    // Wait for draft to load (main loading disappears)
    await waitFor(() => {
      expect(screen.getByText('Quote Draft D-042')).toBeInTheDocument();
    });

    // No badge should be rendered (the sqft <p> has role=status but not with Request age: label)
    expect(screen.queryByRole('status', { name: /Request age:/ })).toBeNull();
    // No deathclock loading text
    expect(screen.queryByText('Loading deathclock...')).toBeNull();
  });

  it('error fetching deathclock does not break page', async () => {
    mockFetchDeathclock.mockRejectedValue(new Error('Server error'));

    renderDraftPage();

    // The page should still render the draft content
    await waitFor(() => {
      expect(screen.getByText('Quote Draft D-042')).toBeInTheDocument();
    });

    // No badge rendered (since deathclock is null after error)
    expect(screen.queryByRole('status', { name: /Request age:/ })).toBeNull();
  });

  // ── T3.2: Lag breakdown section ──

  it('shows request age from deathclock ageLabel', async () => {
    mockFetchDeathclock.mockResolvedValue(makeDeathclock({ ageLabel: '2h', ageSeconds: 7200 }));
    renderDraftPage();

    await waitFor(() => {
      expect(screen.getByText(/Request age:/)).toBeInTheDocument();
    });

    expect(screen.getByText(/Request age: 2h/)).toBeInTheDocument();
  });

  it('shows quote creation lag when quoteCreationLagSeconds is available', async () => {
    mockFetchDeathclock.mockResolvedValue(
      makeDeathclock({ quoteCreationLagSeconds: 3600 }),
    );
    renderDraftPage();

    await waitFor(() => {
      expect(screen.getByText(/Quote creation lag:/)).toBeInTheDocument();
    });

    // 3600 seconds = 1h
    expect(screen.getByText(/Quote creation lag: 1h/)).toBeInTheDocument();
  });

  it('shows send lag when sendLagSeconds is available and quote is complete', async () => {
    mockFetchDeathclock.mockResolvedValue(
      makeDeathclock({ isComplete: true, sendLagSeconds: 1800, frozen: true }),
    );
    renderDraftPage();

    await waitFor(() => {
      expect(screen.getByText(/Send lag:/)).toBeInTheDocument();
    });

    // 1800 seconds = 30m
    expect(screen.getByText(/Send lag: 30m/)).toBeInTheDocument();
  });

  it('does not show send lag when quote is not complete', async () => {
    mockFetchDeathclock.mockResolvedValue(
      makeDeathclock({ isComplete: false, sendLagSeconds: 1800 }),
    );
    renderDraftPage();

    await waitFor(() => {
      expect(screen.getByText(/Request age:/)).toBeInTheDocument();
    });

    // Send lag should NOT appear
    expect(screen.queryByText(/Send lag:/)).toBeNull();
  });

  it('lag section is hidden when no deathclock data', async () => {
    mockFetchDeathclock.mockRejectedValue(new Error('fail'));
    renderDraftPage();

    await waitFor(() => {
      expect(screen.getByText('Quote Draft D-042')).toBeInTheDocument();
    });

    // No lag section
    expect(screen.queryByText(/Request age:/)).toBeNull();
    expect(screen.queryByText(/Quote creation lag:/)).toBeNull();
    expect(screen.queryByText(/Send lag:/)).toBeNull();
  });

  // ── T3.5: Send events section ──

  it('shows send events when isComplete and events exist', async () => {
    const now = new Date().toISOString();
    mockFetchDeathclock.mockResolvedValue(
      makeDeathclock({
        isComplete: true,
        frozen: true,
        sendEvents: [
          { id: 1, quoteId: 'q-1', requestId: 'req-1', sentAt: now, elapsedSecondsFromRequest: 7200, sendType: 'first_send' },
          { id: 2, quoteId: 'q-1', requestId: 'req-1', sentAt: now, elapsedSecondsFromRequest: 86400, sendType: 'resend' },
        ],
        sendLagSeconds: 7200,
      }),
    );
    renderDraftPage();

    await waitFor(() => {
      expect(screen.getByText(/Send events:/)).toBeInTheDocument();
    });
  });

  it('labels first event as "Original"', async () => {
    const now = new Date().toISOString();
    mockFetchDeathclock.mockResolvedValue(
      makeDeathclock({
        isComplete: true,
        frozen: true,
        sendEvents: [
          { id: 1, quoteId: 'q-1', requestId: 'req-1', sentAt: now, elapsedSecondsFromRequest: 7200, sendType: 'first_send' },
          { id: 2, quoteId: 'q-1', requestId: 'req-1', sentAt: now, elapsedSecondsFromRequest: 86400, sendType: 'resend' },
        ],
        sendLagSeconds: 7200,
      }),
    );
    renderDraftPage();

    await waitFor(() => {
      expect(screen.getByText(/Send events:/)).toBeInTheDocument();
    });

    // First event should be labeled "Original"
    const sendEventsContainer = screen.getByText(/Send events:/).parentElement!;
    expect(sendEventsContainer.textContent).toContain('Original');
  });

  it('labels most recent event as "Last sent"', async () => {
    const now = new Date().toISOString();
    mockFetchDeathclock.mockResolvedValue(
      makeDeathclock({
        isComplete: true,
        frozen: true,
        sendEvents: [
          { id: 1, quoteId: 'q-1', requestId: 'req-1', sentAt: now, elapsedSecondsFromRequest: 7200, sendType: 'first_send' },
          { id: 2, quoteId: 'q-1', requestId: 'req-1', sentAt: now, elapsedSecondsFromRequest: 86400, sendType: 'resend' },
        ],
        sendLagSeconds: 7200,
      }),
    );
    renderDraftPage();

    await waitFor(() => {
      expect(screen.getByText(/Send events:/)).toBeInTheDocument();
    });

    // Most recent event should be labeled "Last sent"
    const sendEventsContainer = screen.getByText(/Send events:/).parentElement!;
    expect(sendEventsContainer.textContent).toContain('Last sent');
  });

  it('shows human-readable times via getLabel in send events', async () => {
    const now = new Date().toISOString();
    mockFetchDeathclock.mockResolvedValue(
      makeDeathclock({
        isComplete: true,
        frozen: true,
        sendEvents: [
          { id: 1, quoteId: 'q-1', requestId: 'req-1', sentAt: now, elapsedSecondsFromRequest: 7200, sendType: 'first_send' },
        ],
        sendLagSeconds: 7200,
      }),
    );
    renderDraftPage();

    await waitFor(() => {
      expect(screen.getByText(/Send events:/)).toBeInTheDocument();
    });

    // 7200 seconds = 2h
    const sendEventsContainer = screen.getByText(/Send events:/).parentElement!;
    expect(sendEventsContainer.textContent).toContain('2h');
  });

  it('send events section hidden when no send events', async () => {
    mockFetchDeathclock.mockResolvedValue(
      makeDeathclock({ isComplete: true, frozen: true, sendEvents: undefined, sendLagSeconds: 7200 }),
    );
    renderDraftPage();

    await waitFor(() => {
      expect(screen.getByText(/Send lag:/)).toBeInTheDocument();
    });

    // No send events section
    expect(screen.queryByText(/Send events:/)).toBeNull();
  });
});

describe('DeathclockDashboardPage — Phase 3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchDeathclockStats.mockResolvedValue(makeStats());
    mockFetchTrends.mockResolvedValue(makeTrends());
  });

  // ── T3.3: Dashboard bucket bars ──

  it('renders title "Deathclock Dashboard"', async () => {
    renderDashboardPage();

    expect(await screen.findByText('Deathclock Dashboard')).toBeInTheDocument();
  });

  it('shows active request count', async () => {
    mockFetchDeathclockStats.mockResolvedValue(makeStats({ totalActive: 20 }));
    renderDashboardPage();

    expect(await screen.findByText('20 active requests')).toBeInTheDocument();
  });

  it('renders 4 bucket bars (green/yellow/orange/red)', async () => {
    renderDashboardPage();

    await screen.findByText('Deathclock Dashboard');

    // Each bucket label should render (appears in both bar label and legend)
    expect(screen.getAllByText('Green').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Yellow').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Orange').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Red').length).toBeGreaterThanOrEqual(1);
  });

  it('bars have correct percentages', async () => {
    mockFetchDeathclockStats.mockResolvedValue(
      makeStats({ green: 10, yellow: 5, orange: 3, red: 2, totalActive: 20 }),
    );
    renderDashboardPage();

    await screen.findByText('Deathclock Dashboard');

    // aria-label shows percentage: green=50%, yellow=25%, orange=15%, red=10%
    const [greenBar, yellowBar, orangeBar, redBar] = screen.getAllByRole('button');

    expect(greenBar).toHaveAttribute('aria-label', expect.stringContaining('50%'));
    expect(yellowBar).toHaveAttribute('aria-label', expect.stringContaining('25%'));
    // 3/20 = 15%
    expect(orangeBar).toHaveAttribute('aria-label', expect.stringContaining('15%'));
    // 2/20 = 10%
    expect(redBar).toHaveAttribute('aria-label', expect.stringContaining('10%'));
  });

  it('shows loading state', async () => {
    // Keep promise pending
    mockFetchDeathclockStats.mockReturnValue(new Promise(() => {}));
    renderDashboardPage();

    expect(screen.getByText('Loading deathclock stats…')).toBeInTheDocument();
  });

  it('shows error state with retry button', async () => {
    mockFetchDeathclockStats.mockRejectedValue({ message: 'Failed to load stats.' });
    renderDashboardPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load stats.');

    // Retry button should be present
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('shows empty state when no active requests', async () => {
    mockFetchDeathclockStats.mockResolvedValue(
      makeStats({ green: 0, yellow: 0, orange: 0, red: 0, totalActive: 0 }),
    );
    renderDashboardPage();

    expect(await screen.findByText('Deathclock Dashboard')).toBeInTheDocument();
    expect(screen.getByText('No active requests.')).toBeInTheDocument();
  });

  it('clicking a bar navigates to queue', async () => {
    renderDashboardPage();

    await screen.findByText('Deathclock Dashboard');

    const [firstBar] = screen.getAllByRole('button');
    fireEvent.click(firstBar);

    expect(mockNavigate).toHaveBeenCalledWith('/quotes/queue?sort=age_asc');
  });

  // ── T3.4: Trends section ──

  it('shows 7-Day Avg and 30-Day Avg values', async () => {
    mockFetchTrends.mockResolvedValue(makeTrends({ avg7Days: 43200, avg30Days: 86400 }));
    renderDashboardPage();

    expect(await screen.findByText('7-Day Avg')).toBeInTheDocument();
    expect(screen.getByText('30-Day Avg')).toBeInTheDocument();

    // 43200s = 12h, 86400s = 1.0d
    expect(screen.getByText('12h')).toBeInTheDocument();
    expect(screen.getByText('1.0d')).toBeInTheDocument();
  });

  it('renders SVG chart with bucket bars', async () => {
    renderDashboardPage();

    await screen.findByText('Deathclock Dashboard');

    // The trends section renders an SVG element
    const svg = document.querySelector('svg');
    expect(svg).toBeInTheDocument();

    // There should be rect elements for each bucket
    const rects = svg!.querySelectorAll('rect');
    // Each of 7 days gets 4 bucket rects = 28, plus grid lines... but rects exist
    expect(rects.length).toBeGreaterThan(0);
  });

  it('shows SLA target subtitle', async () => {
    renderDashboardPage();

    expect(await screen.findByText(/SLA target:/)).toBeInTheDocument();
    expect(screen.getByText(/24h/)).toBeInTheDocument();
  });

  it('trends shows loading state', async () => {
    mockFetchTrends.mockReturnValue(new Promise(() => {}));
    renderDashboardPage();

    expect(await screen.findByText('Trends')).toBeInTheDocument();
    // Loading indicator for trends
    expect(screen.getByText('Loading trends…')).toBeInTheDocument();
  });

  it('trends shows error state with retry button', async () => {
    mockFetchTrends.mockRejectedValue({ message: 'Failed to load trends.' });
    renderDashboardPage();

    // Wait for dashboard stats to load first
    await screen.findByText('Deathclock Dashboard');

    // Trends section should show error
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load trends.');
    // There should be a retry button (at least one Retry in the trends section)
    const retryButtons = screen.getAllByText('Retry');
    expect(retryButtons.length).toBeGreaterThanOrEqual(1);
  });

  // ── T6: Edge cases ──

  it('dashboard shows "0 active" when all counts are zero', async () => {
    mockFetchDeathclockStats.mockResolvedValue(
      makeStats({ green: 0, yellow: 0, orange: 0, red: 0, totalActive: 0 }),
    );
    renderDashboardPage();

    await screen.findByText('Deathclock Dashboard');
    // Should hit the empty state, not try to render bars
    expect(screen.getByText('No active requests.')).toBeInTheDocument();
  });

  it('dashboard chart handles totalActive=0 without division by zero', async () => {
    // totalActive=0 but not all counts are zero is unusual, but test the edge:
    // when stats is non-null and totalActive is 0, it shows empty state regardless
    mockFetchDeathclockStats.mockResolvedValue(
      { green: 0, yellow: 0, orange: 0, red: 0, totalActive: 0 },
    );
    renderDashboardPage();

    await screen.findByText('Deathclock Dashboard');
    // Should show empty state, no bars rendered
    expect(screen.getByText('No active requests.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('detail page handles missing deathclock data gracefully', async () => {
    // manualRequestId exists but deathclock fetch fails
    mockFetchDeathclock.mockRejectedValue(new Error('Network error'));
    mockFetchDraft.mockResolvedValue(makeDraft({ manualRequestId: 'req-1' }));
    renderDraftPage();

    await waitFor(() => {
      expect(screen.getByText('Quote Draft D-042')).toBeInTheDocument();
    });

    // Page should be fully functional without deathclock
    expect(screen.queryByRole('status', { name: /Request age:/ })).toBeNull();
    expect(screen.queryByText(/Request age:/)).toBeNull();
    expect(screen.queryByText(/Send events:/)).toBeNull();
    // Back button should still work
    expect(screen.getByText(/← Back to New Quote/)).toBeInTheDocument();
  });

  // ── T4.4: Mark as sent UI ──

  it('shows "Mark as sent" button when deathclock is active', async () => {
    mockFetchDraft.mockResolvedValue(makeDraft({ manualRequestId: 'req-1' }));
    mockFetchDeathclock.mockResolvedValue(makeDeathclock({ isComplete: false, frozen: false }));
    renderDraftPage();
    await waitFor(() => {
      expect(screen.getByText('Quote Draft D-042')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Mark quote as sent/i })).toBeInTheDocument();
  });

  it('does not show "Mark as sent" button when deathclock is complete', async () => {
    mockFetchDraft.mockResolvedValue(makeDraft({ manualRequestId: 'req-1' }));
    mockFetchDeathclock.mockResolvedValue(makeDeathclock({ isComplete: true, frozen: true }));
    renderDraftPage();
    await waitFor(() => {
      expect(screen.getByText('Quote Draft D-042')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Mark quote as sent/i })).toBeNull();
  });

  it('opens confirmation dialog on "Mark as sent" click', async () => {
    mockFetchDraft.mockResolvedValue(makeDraft({ manualRequestId: 'req-1' }));
    mockFetchDeathclock.mockResolvedValue(makeDeathclock({ isComplete: false, frozen: false }));
    renderDraftPage();
    await waitFor(() => {
      expect(screen.getByText('Quote Draft D-042')).toBeInTheDocument();
    });
    // Click the mark-as-sent button
    fireEvent.click(screen.getByRole('button', { name: /Mark quote as sent/i }));
    // Dialog should appear
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Mark quote as sent')).toBeInTheDocument();
  });

  it('calls markRequestSent on confirm and refreshes deathclock', async () => {
    mockFetchDraft.mockResolvedValue(makeDraft({ manualRequestId: 'req-1' }));
    const updatedDc = makeDeathclock({ isComplete: true, frozen: true });
    mockFetchDeathclock
      .mockResolvedValueOnce(makeDeathclock({ isComplete: false, frozen: false })) // initial load
      .mockResolvedValueOnce(updatedDc); // after mark-as-sent
    mockMarkRequestSent.mockResolvedValue({ id: 'req-1' });
    renderDraftPage();
    await waitFor(() => {
      expect(screen.getByText('Quote Draft D-042')).toBeInTheDocument();
    });
    // Open dialog
    fireEvent.click(screen.getByRole('button', { name: /Mark quote as sent/i }));
    // Confirm
    fireEvent.click(screen.getByRole('button', { name: /Confirm mark as sent/i }));
    // Should call markRequestSent with the request id
    await waitFor(() => {
      expect(mockMarkRequestSent).toHaveBeenCalledWith('req-1', undefined);
    });
    // Deathclock should be refreshed
    await waitFor(() => {
      expect(mockFetchDeathclock).toHaveBeenCalledTimes(2);
    });
  });

  it('shows error state when mark-as-sent fails', async () => {
    mockFetchDraft.mockResolvedValue(makeDraft({ manualRequestId: 'req-1' }));
    mockFetchDeathclock.mockResolvedValue(makeDeathclock({ isComplete: false, frozen: false }));
    mockMarkRequestSent.mockRejectedValue(new Error('Server error'));
    renderDraftPage();
    await waitFor(() => {
      expect(screen.getByText('Quote Draft D-042')).toBeInTheDocument();
    });
    // Open dialog
    fireEvent.click(screen.getByRole('button', { name: /Mark quote as sent/i }));
    // Confirm
    fireEvent.click(screen.getByRole('button', { name: /Confirm mark as sent/i }));
    // Error should appear
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Server error');
    });
  });

  // ── T4.5: Multiple quotes per request display ──

  it('shows \"N quotes\" count when siblingQuotes > 1', async () => {
    mockFetchDeathclock.mockResolvedValue(
      makeDeathclock({
        siblingQuotes: [
          { id: 'q-1', draftNumber: 42, quoteSentAt: '2026-05-27T12:00:00Z', firstDraftCreatedAt: null, requestToQuoteSeconds: 7200 },
          { id: 'q-2', draftNumber: 43, quoteSentAt: null, firstDraftCreatedAt: null, requestToQuoteSeconds: null },
        ],
      }),
    );
    renderDraftPage();

    await waitFor(() => {
      expect(screen.getByText('2 quotes')).toBeInTheDocument();
    });
  });

  it('does not show \"N quotes\" count when only one sibling quote', async () => {
    mockFetchDeathclock.mockResolvedValue(
      makeDeathclock({
        siblingQuotes: [
          { id: 'q-1', draftNumber: 42, quoteSentAt: '2026-05-27T12:00:00Z', firstDraftCreatedAt: null, requestToQuoteSeconds: 7200 },
        ],
      }),
    );
    renderDraftPage();

    await waitFor(() => {
      expect(screen.getByText('Quote Draft D-042')).toBeInTheDocument();
    });

    expect(screen.queryByText(/^\d+ quotes$/)).toBeNull();
  });

  it('lists sibling quotes with draft numbers and send status', async () => {
    mockFetchDeathclock.mockResolvedValue(
      makeDeathclock({
        siblingQuotes: [
          { id: 'q-1', draftNumber: 42, quoteSentAt: '2026-05-27T12:00:00Z', firstDraftCreatedAt: null, requestToQuoteSeconds: 7200 },
          { id: 'q-2', draftNumber: 43, quoteSentAt: null, firstDraftCreatedAt: null, requestToQuoteSeconds: null },
        ],
      }),
    );
    renderDraftPage();

    await waitFor(() => {
      expect(screen.getByText(/Quotes for this request:/)).toBeInTheDocument();
    });

    // Should reference draft numbers
    const container = screen.getByText(/Quotes for this request:/).parentElement!;
    expect(container.textContent).toContain('D-042');
    expect(container.textContent).toContain('D-043');
  });

  it('marks earliest sibling quote with (earliest) label', async () => {
    mockFetchDeathclock.mockResolvedValue(
      makeDeathclock({
        siblingQuotes: [
          { id: 'q-1', draftNumber: 42, quoteSentAt: '2026-05-27T12:00:00Z', firstDraftCreatedAt: null, requestToQuoteSeconds: 7200 },
          { id: 'q-2', draftNumber: 43, quoteSentAt: null, firstDraftCreatedAt: null, requestToQuoteSeconds: null },
        ],
      }),
    );
    renderDraftPage();

    await waitFor(() => {
      expect(screen.getByText(/Quotes for this request:/)).toBeInTheDocument();
    });

    expect(screen.getByText(/\(earliest\)/)).toBeInTheDocument();
  });
});
