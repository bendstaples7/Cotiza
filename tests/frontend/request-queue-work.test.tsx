import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import RequestQueuePage from '../../client/src/pages/RequestQueuePage';
import type { LeadContactStatus, LeadInfoItem, LeadWorkflow, ManualRequestWithDeathclock } from '../../client/src/api';
import { checklistMessage } from '../../worker/src/services/lead-contact-status';

const api = vi.hoisted(() => ({
  fetchRequestQueue: vi.fn(),
  fetchLeadSummaries: vi.fn(),
  fetchLeadContactStatuses: vi.fn(),
  setLeadNotALead: vi.fn(),
  closeLead: vi.fn(),
  fetchRequestJobberQuotes: vi.fn(),
  retryJobberNote: vi.fn(),
  warnIfJobberNoteFailed: vi.fn(),
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
const status = (w: LeadWorkflow, last: LeadContactStatus['last'] = null, checklist?: LeadContactStatus['checklist']): LeadContactStatus => ({
  last, next: { on: w.next.on, source: 'suggested', overdue: w.next.overdue, dueToday: w.next.dueToday, reason: w.stage },
  unavailable: [], notConnected: [], recent: [], workflow: w, ...(checklist ? { checklist } : {}),
});

const infoItem = (id: string, question: string, itemStatus: LeadInfoItem['status']): LeadInfoItem => ({
  id, requestId: 'J', question, status: itemStatus, answer: null, required: true,
  createdAt: '', updatedAt: '', createdVia: 'app', updatedVia: 'app',
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
        A: status(workflow({ bucket: 'waiting', pipeline: 'ready_to_quote', step: 3, stage: 'Step 3 · every 2–3 business days', next: { on: '2099-11-10', source: 'suggested', overdue: false, dueToday: false, daysOverdue: 0 }, action: { kind: 'ask_info', label: 'Text: ask for a site visit', why: 'Still need a site visit to quote.', step: 'follow_up', channel: 'text' }, progress: 'getting_info' }),
          { at: '2026-11-03T16:11:00Z', channel: 'note', direction: 'outgoing', source: 'jobber', label: 'Outreach (Jobber note)' }),
        K: status(workflow({ bucket: 'review', pipeline: 'closed', likelySpam: true, action: { kind: 'intro_text', label: 'Send intro text', why: 'No project described yet. Send one intro text or mark it not a lead.', step: 'intro_text', channel: 'text' } })),
        J: status(workflow({ pipeline: 'need_info' })),
      },
    });
  });

  it('shows each lead under its pipeline tab with one action each', async () => {
    renderQueue();
    await screen.findAllByText('Overdue 2 days'); // next steps loaded

    const needInfo = screen.getByRole('region', { name: 'Need info' });
    expect(within(needInfo).getByText('John Oconnell')).toBeInTheDocument();
    expect(within(needInfo).getByText('Overdue 2 days')).toBeInTheDocument();
    expect(within(needInfo).getByText('Step 1 · reach out on intake')).toBeInTheDocument();
    expect(within(needInfo).getByRole('button', { name: 'Send intro text' })).toBeInTheDocument();
    // John has no checklist: the message box carries the placeholder.
    expect(within(needInfo).getByText('No checklist yet')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /Ready to create quote/ }));
    const ready = await screen.findByRole('region', { name: 'Ready to create quote' });
    expect(within(ready).getByText('Anne Brady')).toBeInTheDocument();
    expect(within(ready).getByText('Need: a site visit')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /Closed/ }));
    const closed = await screen.findByRole('region', { name: 'Closed' });
    expect(within(closed).getByText('Katherine Harris')).toBeInTheDocument();
    expect(within(closed).getByRole('button', { name: 'Not a lead' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'How next contact is set' })).toBeInTheDocument();
  });

  it('never counts a lead as "do now" before its next step is known', async () => {
    api.fetchLeadContactStatuses.mockReturnValue(new Promise(() => {}));
    renderQueue();
    const pending = await screen.findByRole('region', { name: 'Checking next steps' });
    expect(within(pending).getByText('John Oconnell')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Need info' })).not.toBeInTheDocument();
  });

  it('shows leads whose status failed as unknown, not as work to do', async () => {
    api.fetchLeadContactStatuses.mockRejectedValue(new Error('boom'));
    renderQueue();
    const unknown = await screen.findByRole('region', { name: 'Next step unknown' });
    expect(within(unknown).getByText('Anne Brady')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Need info' })).not.toBeInTheDocument();
  });

  it('opens the lead page with the action preselected', async () => {
    renderQueue();
    await screen.findAllByText('Overdue 2 days');
    const needInfo = screen.getByRole('region', { name: 'Need info' });
    await userEvent.click(within(needInfo).getByRole('button', { name: 'Send intro text' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/quotes/leads/J?action=intro_text');
  });

  it('marks a lead as not a lead', async () => {
    renderQueue();
    await screen.findByText('Overdue 2 days');
    await userEvent.click(screen.getByRole('tab', { name: /Closed/ }));
    const closed = await screen.findByRole('region', { name: 'Closed' });
    await userEvent.click(within(closed).getByRole('button', { name: 'Not a lead' }));
    expect(api.setLeadNotALead).toHaveBeenCalledWith('K', true);
  });

  it('mockup row layout', async () => {
    api.fetchLeadContactStatuses.mockResolvedValue({
      statuses: {
        A: status(workflow({ bucket: 'waiting', pipeline: 'ready_to_quote', next: { on: '2099-11-10', source: 'suggested', overdue: false, dueToday: false, daysOverdue: 0 } })),
        K: status(workflow({ bucket: 'review', pipeline: 'closed', likelySpam: true })),
        J: status(workflow({
          ageDays: 7, progress: 'ready_to_quote', pipeline: 'need_info',
          action: { kind: 'draft_quote', label: 'Draft quote', why: 'We have what we need to quote. No open questions.', step: 'draft_quote', channel: 'other' },
          secondary: { kind: 'quote_update', label: 'Send “quote in progress” text', why: 'Let them know it’s coming.', step: 'quote_update', channel: 'text' },
        })),
      },
    });
    renderQueue();
    const needInfo = await screen.findByRole('region', { name: 'Need info' });
    const row = await within(needInfo).findByRole('article', { name: 'Lead: John Oconnell' });
    expect(within(row).getByText(/^Received Nov 2 · /)).toBeInTheDocument();
    expect(within(row).queryByTestId('lead-received-badge')).not.toBeInTheDocument();
    expect(within(row).getAllByTestId('lead-message-box')).toHaveLength(1);
    expect(within(row).getAllByRole('button')).toHaveLength(1);
    expect(within(row).getByRole('link', { name: 'John Oconnell' })).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Draft quote' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/quotes/leads/J?action=draft_quote');
  });

  it('a lead lost in Trello sits in Review with "Close in Cotiza too"', async () => {
    api.closeLead.mockResolvedValue({ closure: {}, jobberNote: null, jobberArchive: { status: 'archived' }, trello: null, trelloReminder: false });
    api.fetchLeadContactStatuses.mockResolvedValue({
      statuses: {
        A: status(workflow({ bucket: 'waiting', pipeline: 'ready_to_quote', next: { on: '2099-11-10', source: 'suggested', overdue: false, dueToday: false, daysOverdue: 0 } })),
        K: status(workflow({ bucket: 'review', pipeline: 'closed', lostInTrello: true, action: { kind: 'lost_in_trello', label: 'Close in Cotiza too', why: 'Lost in Trello: the card is in Bid Lost.', step: 'none', channel: 'other' } })),
        J: status(workflow({ pipeline: 'need_info' })),
      },
    });
    renderQueue();
    await screen.findByText('Overdue 2 days');
    await userEvent.click(screen.getByRole('tab', { name: /Closed/ }));
    const closed = await screen.findByRole('region', { name: 'Closed' });
    const row = await within(closed).findByRole('article', { name: 'Lead: Katherine Harris' });
    expect(within(row).queryByRole('button', { name: 'Not a lead' })).not.toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Close in Cotiza too' }));
    expect(api.closeLead).toHaveBeenCalledWith('K', { reason: 'other', note: 'Already in Bid Lost in Trello' });
  });

  it('renders one bundled message: greeting, numbered open questions, Assumed lines, and Copy', async () => {
    api.fetchLeadSummaries.mockResolvedValue({ summaries: { J: { total: 4, open: 3, asked: 0, answered: 1, readyToQuote: false } } });
    api.fetchLeadContactStatuses.mockResolvedValue({ statuses: { J: status(workflow({ pipeline: 'need_info' }), null, {
      openQuestions: ['Can you send photos of the lower level?', 'Is the ceiling staying?', 'a quick video helps.'],
      assumedLines: ['Assumed: about 80 linear feet of exterior wall.'],
    }) } });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderQueue();
    const needInfo = await screen.findByRole('region', { name: 'Need info' });
    const row = await within(needInfo).findByRole('article', { name: 'Lead: John Oconnell' });
    const box = within(row).getByTestId('lead-message-box');
    const message = within(box).getByTestId('lead-message-text').textContent ?? '';
    expect(message).toContain('Hi John, this is Chicago Reno about your Basement drain tile request.');
    expect(message).toContain('1) Can you send photos of the lower level?\n2) Is the ceiling staying?\n3) a quick video helps.');
    expect(message).toContain('Assumed: about 80 linear feet of exterior wall');
    await userEvent.click(within(box).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(message);
  });

  it('builds the checklist payload from open and asked items only', () => {
    expect(checklistMessage([
      infoItem('1', 'Can you send photos?', 'open'),
      infoItem('2', 'Optional: a quick video helps.', 'asked'),
      infoItem('3', 'Assumed: about 80 linear feet.', 'open'),
      infoItem('4', 'Answered one', 'answered'),
      infoItem('5', 'Dropped one', 'dropped'),
    ])).toEqual({ openQuestions: ['Can you send photos?', 'a quick video helps.'], assumedLines: ['Assumed: about 80 linear feet.'] });
  });
});
