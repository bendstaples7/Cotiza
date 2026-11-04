import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import RequestQueuePage from '../../client/src/pages/RequestQueuePage';
import type { LeadContactStatus, LeadWorkflow, ManualRequestWithDeathclock } from '../../client/src/api';

const api = vi.hoisted(() => ({
  fetchRequestQueue: vi.fn(),
  fetchLeadSummaries: vi.fn(),
  fetchLeadContactStatuses: vi.fn(),
  setLeadNotALead: vi.fn(),
  fetchRequestJobberQuotes: vi.fn(),
}));
vi.mock('../../client/src/api', () => api);

const lead = (id: string, name: string, title: string, createdAt: string): ManualRequestWithDeathclock => ({
  id, userId: 'u', customerName: name, customerPhone: null, customerEmail: null, customerAddress: null,
  serviceDescription: title, mediaItemIds: [], requestSource: 'jobber', createdAt: createdAt as unknown as Date,
  ageSeconds: 0, quoteSentAt: null, jobberRequestId: id, requestTitle: title,
  deathclock: { ageSeconds: 0, ageLabel: '0m', color: 'green', isComplete: false, frozen: false },
} as ManualRequestWithDeathclock);

const workflow = (over: Partial<LeadWorkflow>): LeadWorkflow => ({
  bucket: 'do_now', step: 1, stage: 'Step 1 · reach out on intake',
  next: { on: '2026-11-02', source: 'suggested', overdue: true, dueToday: false, daysOverdue: 2 },
  action: { kind: 'intro_text', label: 'Send intro text', why: 'Nobody has contacted them yet.', step: 'intro_text', channel: 'text' },
  progress: 'lead_in', ageDays: 2, likelySpam: false, notALead: false, plan: [], ...over,
});
const status = (w: LeadWorkflow, last: LeadContactStatus['last'] = null): LeadContactStatus => ({
  last, next: { on: w.next.on, source: 'suggested', overdue: w.next.overdue, dueToday: w.next.dueToday, reason: w.stage },
  unavailable: [], notConnected: [], recent: [], workflow: w,
});

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname + loc.search}</p>;
}

function renderQueue() {
  return render(
    <MemoryRouter initialEntries={['/quotes/requests']}>
      <Routes>
        <Route path="/quotes/requests" element={<RequestQueuePage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Requests work queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchLeadSummaries.mockResolvedValue({ summaries: { A: { total: 2, open: 1, asked: 0, answered: 1, readyToQuote: false } } });
    api.fetchRequestJobberQuotes.mockResolvedValue({});
    api.setLeadNotALead.mockResolvedValue({ notALead: true });
    api.fetchRequestQueue.mockResolvedValue({
      requests: [
        lead('A', 'Anne Brady', 'Basement rec room', '2026-10-08T19:49:00Z'),
        lead('K', 'Katherine Harris', '', '2026-10-16T14:19:00Z'),
        lead('J', 'John Oconnell', 'Basement drain tile', '2026-11-02T13:31:00Z'),
      ],
      jobber: { status: 'live', days: 60, complete: true },
    });
    api.fetchLeadContactStatuses.mockResolvedValue({
      statuses: {
        A: status(workflow({ bucket: 'waiting', step: 3, stage: 'Step 3 · every 2–3 business days', next: { on: '2099-11-10', source: 'suggested', overdue: false, dueToday: false, daysOverdue: 0 }, action: { kind: 'ask_info', label: 'Text: ask for a site visit', why: 'Still need a site visit to quote.', step: 'follow_up', channel: 'text' }, progress: 'getting_info' }),
          { at: '2026-11-03T16:11:00Z', channel: 'note', direction: 'outgoing', source: 'jobber', label: 'Outreach (Jobber note)' }),
        K: status(workflow({ bucket: 'review', likelySpam: true, action: { kind: 'intro_text', label: 'Send intro text', why: 'No project described yet. Send one intro text or mark it not a lead.', step: 'intro_text', channel: 'text' } })),
        J: status(workflow({})),
      },
    });
  });

  it('sorts leads into Do now, Waiting on customer and Review with one action each', async () => {
    renderQueue();
    await screen.findByText('Overdue 2 days'); // next steps loaded
    const doNow = screen.getByRole('region', { name: 'Do now' });
    expect(within(doNow).getByText('John Oconnell')).toBeInTheDocument();
    expect(within(doNow).getByText('Overdue 2 days')).toBeInTheDocument();
    expect(within(doNow).getByText('Step 1 · reach out on intake')).toBeInTheDocument();
    expect(within(doNow).getByRole('button', { name: 'Send intro text' })).toBeInTheDocument();
    expect(within(doNow).getByText('No outreach yet')).toBeInTheDocument();

    const waiting = screen.getByRole('region', { name: 'Waiting on customer' });
    expect(within(waiting).getByText('Anne Brady')).toBeInTheDocument();
    expect(within(waiting).getByText('Outreach (Jobber note)')).toBeInTheDocument();
    expect(within(waiting).getByText('Need: a site visit')).toBeInTheDocument();

    const review = screen.getByRole('region', { name: 'Review' });
    expect(within(review).getByText('Katherine Harris')).toBeInTheDocument();
    expect(within(review).getByRole('button', { name: 'Not a lead' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'How next contact is set' })).toBeInTheDocument();
    // John has no checklist: no readiness chip.
    expect(within(doNow).queryByText('No checklist yet')).not.toBeInTheDocument();
  });

  it('never counts a lead as "do now" before its next step is known', async () => {
    api.fetchLeadContactStatuses.mockReturnValue(new Promise(() => {}));
    renderQueue();
    const pending = await screen.findByRole('region', { name: 'Checking next steps' });
    expect(within(pending).getByText('John Oconnell')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Do now' })).not.toBeInTheDocument();
  });

  it('shows leads whose status failed as unknown, not as work to do', async () => {
    api.fetchLeadContactStatuses.mockRejectedValue(new Error('boom'));
    renderQueue();
    const unknown = await screen.findByRole('region', { name: 'Next step unknown' });
    expect(within(unknown).getByText('Anne Brady')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Do now' })).not.toBeInTheDocument();
  });

  it('opens the lead page with the action preselected', async () => {
    renderQueue();
    await screen.findByText('Overdue 2 days');
    const doNow = screen.getByRole('region', { name: 'Do now' });
    await userEvent.click(within(doNow).getByRole('button', { name: 'Send intro text' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/quotes/leads/J?action=intro_text');
  });

  it('marks a lead as not a lead', async () => {
    renderQueue();
    const review = await screen.findByRole('region', { name: 'Review' });
    await userEvent.click(within(review).getByRole('button', { name: 'Not a lead' }));
    expect(api.setLeadNotALead).toHaveBeenCalledWith('K', true);
  });
});
