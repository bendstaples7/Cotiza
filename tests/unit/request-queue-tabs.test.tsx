import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import RequestQueuePage from '../../client/src/pages/RequestQueuePage';
import type { LeadContactStatus, LeadPipeline, LeadWorkflow, ManualRequestWithDeathclock } from '../../client/src/api';

const api = vi.hoisted(() => ({
  fetchRequestQueue: vi.fn(),
  fetchLeadSummaries: vi.fn(),
  fetchLeadContactStatuses: vi.fn(),
  fetchRequestJobberQuotes: vi.fn(),
  setLeadNotALead: vi.fn(),
  closeLead: vi.fn(),
  warnIfJobberNoteFailed: vi.fn(),
  enrichManualRequests: vi.fn(),
  generateQuote: vi.fn(),
  fetchDrafts: vi.fn(),
  deleteDraft: vi.fn(),
  resolveRequestQuote: vi.fn(),
}));
vi.mock('../../client/src/api', () => api);

const lead = (id: string, name: string, createdAt: string): ManualRequestWithDeathclock => ({
  id, userId: 'u', customerName: name, customerPhone: null, customerEmail: null, customerAddress: null,
  serviceDescription: '', mediaItemIds: [], requestSource: 'jobber', createdAt: createdAt as unknown as Date,
  ageSeconds: 0, quoteSentAt: null, jobberRequestId: id, requestTitle: '',
  deathclock: { ageSeconds: 0, ageLabel: '0m', color: 'green', isComplete: false, frozen: false },
} as ManualRequestWithDeathclock);

const manualLead = (id: string, name: string, createdAt: string): ManualRequestWithDeathclock => ({
  ...lead(id, name, createdAt), requestSource: 'manual', jobberRequestId: null, requestTitle: name,
} as ManualRequestWithDeathclock);

const workflow = (pipeline: LeadPipeline): LeadWorkflow => ({
  bucket: 'do_now', step: 1, stage: 'Step 1 · reach out on intake',
  next: { on: '2026-11-02', source: 'suggested', overdue: true, dueToday: false, daysOverdue: 2 },
  action: { kind: 'intro_text', label: 'Send intro text', why: 'Nobody has contacted them yet.', step: 'intro_text', channel: 'text' },
  progress: 'lead_in', pipeline, ageDays: 2, likelySpam: false, notALead: false, plan: [],
});

const status = (w: LeadWorkflow, last: LeadContactStatus['last'] = null): LeadContactStatus => ({
  last, next: { on: w.next.on, source: 'suggested', overdue: w.next.overdue, dueToday: w.next.dueToday, reason: w.stage },
  unavailable: [], notConnected: [], recent: [], workflow: w,
});

const LEADS = [
  lead('N1', 'Nina Needinfo', '2026-10-01T00:00:00Z'),
  lead('N2', 'Noah Needinfo', '2026-10-02T00:00:00Z'),
  lead('R1', 'Rita Ready', '2026-10-03T00:00:00Z'),
  lead('Q1', 'Quinn Quote', '2026-10-04T00:00:00Z'),
  lead('C1', 'Cal Closed', '2026-10-05T00:00:00Z'),
];
const STATUSES: Record<string, LeadContactStatus | null> = {
  N1: status(workflow('need_info')),
  N2: status(workflow('need_info')),
  R1: status(workflow('ready_to_quote')),
  Q1: status(workflow('quote_created')),
  C1: status(workflow('closed')),
};

function renderQueue() {
  return render(
    <MemoryRouter initialEntries={['/quotes/requests']}>
      <RequestQueuePage />
    </MemoryRouter>,
  );
}

describe('Requests pipeline tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchLeadSummaries.mockResolvedValue({ summaries: {} });
    api.fetchRequestJobberQuotes.mockResolvedValue({});
    api.fetchRequestQueue.mockResolvedValue({ requests: LEADS, jobber: { status: 'live', days: 60, complete: true } });
    api.fetchLeadContactStatuses.mockResolvedValue({ statuses: STATUSES });
  });

  it('tab row shows the four pipeline tabs with counts', async () => {
    renderQueue();
    await screen.findByRole('article', { name: 'Lead: Nina Needinfo' });

    expect(screen.getAllByRole('tab')).toHaveLength(4);

    const needInfo = screen.getByRole('tab', { name: /Need info/ });
    expect(needInfo).toHaveAttribute('aria-selected', 'true');
    expect(within(needInfo).getByText('2')).toBeInTheDocument();
    expect(within(screen.getByRole('tab', { name: /Ready to create quote/ })).getByText('1')).toBeInTheDocument();
    expect(within(screen.getByRole('tab', { name: /Quote created/ })).getByText('1')).toBeInTheDocument();
    expect(within(screen.getByRole('tab', { name: /Closed/ })).getByText('1')).toBeInTheDocument();
  });

  it("selecting a tab shows that pipeline's lead rows", async () => {
    // 44 fillers keep P1 in a second status batch, so it stays pending while the rest resolve.
    const fillers = Array.from({ length: 44 }, (_, i) => lead(`F${i}`, `Filler ${i}`, '2026-09-01T00:00:00Z'));
    const fillerStatuses = Object.fromEntries(fillers.map((f) => [f.jobberRequestId as string, status(workflow('need_info'))]));
    api.fetchRequestQueue.mockResolvedValue({
      requests: [...LEADS, lead('U1', 'Uma Unknown', '2026-10-06T00:00:00Z'), ...fillers, lead('P1', 'Pat Pending', '2026-10-07T00:00:00Z')],
      jobber: { status: 'live', days: 60, complete: true },
    });
    api.fetchLeadContactStatuses.mockImplementation((ids: string[]) =>
      ids.includes('P1')
        ? new Promise(() => {})
        : Promise.resolve({ statuses: { ...STATUSES, U1: null, ...fillerStatuses } }));

    renderQueue();
    await screen.findByRole('article', { name: 'Lead: Nina Needinfo' });

    await userEvent.click(screen.getByRole('tab', { name: /Quote created/ }));

    expect(screen.getByRole('article', { name: 'Lead: Quinn Quote' })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Lead: Nina Needinfo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Lead: Rita Ready' })).not.toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Lead: Cal Closed' })).not.toBeInTheDocument();
    // Pending and unknown rows stay visible under any tab.
    const pending = screen.getByRole('region', { name: 'Checking next steps' });
    expect(within(pending).getByText('Pat Pending')).toBeInTheDocument();
    const unknown = screen.getByRole('region', { name: 'Next step unknown' });
    expect(within(unknown).getByText('Uma Unknown')).toBeInTheDocument();
  });

  it('manual requests section still renders', async () => {
    api.fetchRequestQueue.mockResolvedValue({
      requests: [...LEADS, manualLead('M1', 'Mona Manual', '2026-10-08T00:00:00Z')],
      jobber: { status: 'live', days: 60, complete: true },
    });

    renderQueue();
    await screen.findByRole('article', { name: 'Lead: Nina Needinfo' });

    expect(screen.getByRole('heading', { name: 'Manual requests' })).toBeInTheDocument();
    expect(screen.getByText('Mona Manual')).toBeInTheDocument();
  });

  it('oldest/newest sort still orders rows', async () => {
    const asc = [
      lead('A', 'Oldest Lead', '2026-10-01T00:00:00Z'),
      lead('B', 'Middle Lead', '2026-10-02T00:00:00Z'),
      lead('C', 'Newest Lead', '2026-10-03T00:00:00Z'),
    ];
    const desc = [...asc].reverse();
    api.fetchRequestQueue.mockImplementation((sort?: 'age_asc' | 'age_desc') =>
      Promise.resolve({ requests: sort === 'age_desc' ? desc : asc, jobber: { status: 'live', days: 60, complete: true } }));
    api.fetchLeadContactStatuses.mockResolvedValue({
      statuses: { A: status(workflow('need_info')), B: status(workflow('need_info')), C: status(workflow('need_info')) },
    });

    renderQueue();
    await screen.findByRole('article', { name: 'Lead: Oldest Lead' });
    const order = () => screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'));
    expect(order()).toEqual(['Lead: Oldest Lead', 'Lead: Middle Lead', 'Lead: Newest Lead']);

    await userEvent.click(screen.getByRole('button', { name: 'Sort newest first' }));
    await screen.findByRole('article', { name: 'Lead: Newest Lead' });
    await waitFor(() => expect(order()).toEqual(['Lead: Newest Lead', 'Lead: Middle Lead', 'Lead: Oldest Lead']));

    await userEvent.click(screen.getByRole('button', { name: 'Sort oldest first' }));
    await waitFor(() => expect(order()).toEqual(['Lead: Oldest Lead', 'Lead: Middle Lead', 'Lead: Newest Lead']));
  });

  it('tab switch renders the selected rows before any fetch resolves', async () => {
    api.fetchRequestQueue.mockResolvedValueOnce({ requests: LEADS, jobber: { status: 'live', days: 60, complete: true } });
    api.fetchRequestQueue.mockReturnValue(new Promise(() => {}));
    api.fetchLeadContactStatuses.mockResolvedValueOnce({ statuses: STATUSES });
    api.fetchLeadContactStatuses.mockReturnValue(new Promise(() => {}));
    api.fetchLeadSummaries.mockReturnValue(new Promise(() => {}));
    api.fetchRequestJobberQuotes.mockReturnValue(new Promise(() => {}));

    renderQueue();
    await screen.findByRole('article', { name: 'Lead: Nina Needinfo' });

    await userEvent.click(screen.getByRole('tab', { name: /Quote created/ }));

    // The tab switch is local state only; the new rows render with no fetch resolving.
    expect(screen.getByRole('article', { name: 'Lead: Quinn Quote' })).toBeInTheDocument();
  });
});
