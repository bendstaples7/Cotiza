import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import DeathclockBadge, { getLabel } from '../../client/src/components/DeathclockBadge';
import RequestQueuePage from '../../client/src/pages/RequestQueuePage';
import type { ManualRequestWithDeathclock } from '../../client/src/api';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFetchManualRequests = vi.hoisted(() => vi.fn<() => Promise<ManualRequestWithDeathclock[]>>());
vi.mock('../../client/src/api', () => ({
  fetchManualRequests: mockFetchManualRequests,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderBadge(props: Partial<Parameters<typeof DeathclockBadge>[0]> = {}) {
  return render(
    <DeathclockBadge
      ageSeconds={3600}
      color="green"
      isComplete={false}
      frozen={false}
      {...props}
    />,
  );
}

function makeRequest(overrides: Partial<ManualRequestWithDeathclock> = {}): ManualRequestWithDeathclock {
  return {
    id: 'req-1',
    userId: 'user-1',
    customerName: 'Jane Doe',
    customerPhone: '+1-555-1234',
    customerEmail: 'jane@example.com',
    customerAddress: '123 Main St',
    serviceDescription: 'Full kitchen renovation including cabinets, countertops, and backsplash',
    mediaItemIds: [],
    requestSource: 'manual',
    createdAt: new Date('2026-05-20').toISOString() as unknown as Date,
    ageSeconds: 7200,
    quoteSentAt: null,
    deathclock: {
      ageSeconds: 7200,
      ageLabel: '2h',
      color: 'green',
      isComplete: false,
      frozen: false,
    },
    ...overrides,
  };
}

function renderQueue(initialEntries = ['/requests']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <RequestQueuePage />
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// DeathclockBadge — unit tests
// ---------------------------------------------------------------------------

describe('DeathclockBadge', () => {
  describe('label formatting (getLabel)', () => {
    it('formats less than 1 minute as "1m"', () => {
      expect(getLabel(0)).toBe('1m');
      expect(getLabel(30)).toBe('1m');
      expect(getLabel(59)).toBe('1m');
    });

    it('formats less than 60 minutes as "Xm"', () => {
      expect(getLabel(60)).toBe('1m');
      expect(getLabel(600)).toBe('10m');
      expect(getLabel(3540)).toBe('59m');
    });

    it('formats less than 24 hours as "Xh"', () => {
      expect(getLabel(3600)).toBe('1h');
      expect(getLabel(7200)).toBe('2h');
      expect(getLabel(82800)).toBe('23h'); // 23h
    });

    it('formats less than 7 days as "X.Xd"', () => {
      expect(getLabel(86400)).toBe('1.0d');
      expect(getLabel(129600)).toBe('1.5d');
      expect(getLabel(518400)).toBe('6.0d');
    });

    it('formats less than 90 days as "Xd Xh"', () => {
      expect(getLabel(604800)).toBe('7d 0h'); // 7 days exactly
      expect(getLabel(86400 * 8 + 3600 * 3)).toBe('8d 3h'); // 8d 3h
      expect(getLabel(86400 * 30)).toBe('30d 0h');
      expect(getLabel(86400 * 89 + 3600 * 23)).toBe('89d 23h');
    });

    it('formats 90 days or more as "99+ days"', () => {
      expect(getLabel(86400 * 90)).toBe('99+ days');
      expect(getLabel(86400 * 100)).toBe('99+ days');
      expect(getLabel(86400 * 365)).toBe('99+ days');
    });
  });

  describe('renders colored dot for each color', () => {
    const colors = ['green', 'yellow', 'orange', 'red'] as const;

    colors.forEach((color) => {
      it(`renders ${color} dot and label`, () => {
        renderBadge({ color, ageSeconds: 7200 });
        const container = screen.getByRole('status');
        expect(container).toBeInTheDocument();
        // Each color renders label based on ageSeconds
        expect(container).toHaveTextContent('2h');
        // The colored dot is an aria-hidden span
        const dot = container.querySelector('span[aria-hidden="true"]');
        expect(dot).toBeInTheDocument();
      });
    });
  });

  describe('aria and role attributes', () => {
    it('has role="status" on the container', () => {
      renderBadge({ color: 'red', ageSeconds: 3600 });
      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    it('has aria-label matching age and color', () => {
      renderBadge({ color: 'orange', ageSeconds: 86400 });
      const badge = screen.getByRole('status');
      expect(badge).toHaveAttribute('aria-label', 'Age: 1.0d, orange');
    });

    it('has a title attribute matching aria-label', () => {
      renderBadge({ color: 'green', ageSeconds: 7200 });
      const badge = screen.getByRole('status');
      expect(badge).toHaveAttribute('title', 'Age: 2h, green');
    });
  });

  describe('frozen mode', () => {
    it('renders lock indicator when frozen', () => {
      renderBadge({ frozen: true });
      expect(screen.getByLabelText('Frozen')).toBeInTheDocument();
      // No pulse style tag should be injected
      expect(document.querySelector('style')).toBeNull();
    });

    it('renders lock indicator when isComplete', () => {
      renderBadge({ isComplete: true });
      expect(screen.getByLabelText('Frozen')).toBeInTheDocument();
    });

    it('does not render lock indicator when not frozen and not complete', () => {
      renderBadge({ frozen: false, isComplete: false });
      expect(screen.queryByLabelText('Frozen')).toBeNull();
    });
  });

  describe('compact mode', () => {
    it('renders narrower styling when compact is true', () => {
      const { container } = render(
        <DeathclockBadge
          ageSeconds={3600}
          color="green"
          isComplete={false}
          frozen={false}
          compact
        />,
      );
      const badge = screen.getByRole('status');
      // In compact mode, padding is '1px 6px' vs '2px 10px' — check the style attribute
      expect(badge.getAttribute('style')).toContain('1px 6px');
    });

    it('renders default sizing when compact is not set', () => {
      renderBadge({ compact: false });
      const badge = screen.getByRole('status');
      expect(badge.getAttribute('style')).toContain('2px 10px');
    });
  });

  describe('pulse animation', () => {
    it('injects @keyframes pulse for yellow', () => {
      renderBadge({ color: 'yellow' });
      const styles = document.querySelectorAll('style');
      expect(styles.length).toBeGreaterThanOrEqual(1);
      const hasPulse = Array.from(styles).some((s) =>
        s.textContent?.includes('@keyframes dc-pulse'),
      );
      expect(hasPulse).toBe(true);
    });

    it('injects @keyframes pulse for orange', () => {
      renderBadge({ color: 'orange' });
      const styles = document.querySelectorAll('style');
      const hasPulse = Array.from(styles).some((s) =>
        s.textContent?.includes('@keyframes dc-pulse'),
      );
      expect(hasPulse).toBe(true);
    });

    it('injects @keyframes pulse for red', () => {
      renderBadge({ color: 'red' });
      const styles = document.querySelectorAll('style');
      const hasPulse = Array.from(styles).some((s) =>
        s.textContent?.includes('@keyframes dc-pulse'),
      );
      expect(hasPulse).toBe(true);
    });

    it('does NOT inject pulse for green', () => {
      renderBadge({ color: 'green' });
      const styles = document.querySelectorAll('style');
      const hasPulse = Array.from(styles).some((s) =>
        s.textContent?.includes('@keyframes dc-pulse'),
      );
      expect(hasPulse).toBe(false);
    });

    it('does NOT inject pulse when frozen', () => {
      renderBadge({ color: 'red', frozen: true });
      expect(document.querySelector('style')).toBeNull();
    });

    it('does NOT inject pulse when isComplete', () => {
      renderBadge({ color: 'red', isComplete: true });
      expect(document.querySelector('style')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// RequestQueuePage — integration tests
// ---------------------------------------------------------------------------

describe('RequestQueuePage', () => {
  beforeEach(() => {
    mockFetchManualRequests.mockReset();
  });

  it('renders loading state initially', async () => {
    // Never resolve the promise so loading persists
    mockFetchManualRequests.mockReturnValue(new Promise(() => {}));
    renderQueue();

    // Should show loading indicator
    expect(screen.getByText('Loading request queue…')).toBeInTheDocument();
  });

  it('renders empty state when no requests returned', async () => {
    mockFetchManualRequests.mockResolvedValue([]);
    renderQueue();

    expect(await screen.findByText('No pending requests in the queue.')).toBeInTheDocument();
  });

  it('renders error state on API failure', async () => {
    mockFetchManualRequests.mockRejectedValue({
      severity: 'error',
      message: 'Server is down',
      component: 'API',
      operation: 'fetchManualRequests',
      actions: [],
    });
    renderQueue();

    expect(await screen.findByRole('alert')).toHaveTextContent('Server is down');
  });

  it('renders cards with DeathclockBadge when data loaded', async () => {
    const requests = [
      makeRequest({
        id: 'req-1',
        customerName: 'Alice',
        deathclock: { ageSeconds: 1800, ageLabel: '30m', color: 'green', isComplete: false, frozen: false },
      }),
      makeRequest({
        id: 'req-2',
        customerName: 'Bob',
        deathclock: { ageSeconds: 72000, ageLabel: '20h', color: 'yellow', isComplete: false, frozen: false },
      }),
    ];
    mockFetchManualRequests.mockResolvedValue(requests);
    renderQueue();

    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(await screen.findByText('Bob')).toBeInTheDocument();

    // Each card gets a DeathclockBadge (role="status") — there should be two
    const badges = screen.getAllByRole('status');
    expect(badges.length).toBe(2);
  });

  it('renders sort toggle buttons with correct labels', async () => {
    mockFetchManualRequests.mockResolvedValue([]);
    renderQueue();

    expect(await screen.findByText('Oldest First')).toBeInTheDocument();
    expect(screen.getByText('Newest First')).toBeInTheDocument();
  });

  it('clicking sort toggle navigates with correct sort param', async () => {
    mockFetchManualRequests.mockResolvedValue([]);
    renderQueue(['/requests?sort=age_asc']);

    expect(await screen.findByText('Oldest First')).toBeInTheDocument();

    const newestButton = screen.getByRole('button', { name: /Sort newest first/i });
    await userEvent.click(newestButton);

    // Wait for the mock to be called with 'age_desc'
    await waitFor(() => {
      const calls = mockFetchManualRequests.mock.calls.filter(
        ([arg]) => arg === 'age_desc',
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
    });
  });
});