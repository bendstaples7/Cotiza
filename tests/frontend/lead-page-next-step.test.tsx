import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LeadPage from '../../client/src/pages/LeadPage';
import type { LeadBundle, LeadWorkflow } from '../../client/src/api';

const api = vi.hoisted(() => ({
  fetchLead: vi.fn(),
  fetchLeadPhotoUrl: vi.fn(),
  addLeadInfo: vi.fn(),
  updateLeadInfo: vi.fn(),
  logLeadContact: vi.fn(),
  sendLeadText: vi.fn(),
  setLeadNextContact: vi.fn(),
  setLeadNotALead: vi.fn(),
  retryJobberNote: vi.fn(),
  warnIfJobberNoteFailed: vi.fn(),
}));
vi.mock('../../client/src/api', () => api);

const present = <T,>(value: T) => ({ availability: 'present' as const, value });
const REQ = 'Z2lkOi8vSm9iYmVyL1JlcXVlc3QvMzU3NTQyMjI=';

const workflow: LeadWorkflow = {
  bucket: 'do_now', step: 2, stage: 'Step 2 · next day after intake',
  next: { on: '2026-11-03', source: 'suggested', overdue: true, dueToday: false, daysOverdue: 1 },
  action: { kind: 'ask_info', label: 'Text: ask for photos', why: 'Still need photos to quote.', step: 'follow_up', channel: 'text' },
  progress: 'getting_info', ageDays: 2, likelySpam: false, notALead: false,
  plan: [
    { label: 'Intake', detail: 'Mon, Nov 2 · Outreach (Jobber note)', state: 'done' },
    { label: 'Next day', detail: 'Missed: was due Tue, Nov 3. Do it today.', state: 'missed' },
    { label: 'Every 2–3 business days', detail: 'Until we have the photos or info we need', state: 'upcoming' },
    { label: 'Weekly', detail: 'If they go quiet', state: 'upcoming' },
    { label: 'Monthly', detail: 'After several weekly tries', state: 'upcoming' },
  ],
};

const bundle: LeadBundle = {
  requestId: REQ,
  request: {
    outcome: 'ok',
    request: {
      title: present('Wall Project'), status: present('new'), clientName: present('Bryan Waters'),
      jobberWebUri: present('https://secure.getjobber.com/work_requests/35754222'), createdAt: present('2026-11-02T22:10:07Z'),
      requestBody: present('Walls out and rebuilt'), notes: [], attachments: [],
    },
  },
  quotes: { jobberQuotes: { outcome: 'ok', items: [] } },
  contact: { email: null, phone: '(773) 555-0100' },
  email: { status: 'not_connected' },
  phone: { status: 'not_connected' },
  infoNeeded: {
    items: [
      { id: 'lii_1', requestId: REQ, question: 'Can you send a few photos of the walls?', status: 'open', answer: null, required: true, createdAt: '', updatedAt: '', createdVia: 'assistant', updatedVia: 'assistant' },
      { id: 'lii_2', requestId: REQ, question: 'Assumed: about 80 ft of exterior wall.', status: 'open', answer: null, required: false, createdAt: '', updatedAt: '', createdVia: 'assistant', updatedVia: 'assistant' },
    ],
    summary: { total: 2, open: 2, asked: 0, answered: 0, readyToQuote: false },
  },
  contactStatus: {
    last: { at: '2026-11-02T22:11:50Z', channel: 'note', direction: 'outgoing', source: 'jobber', label: 'Outreach (Jobber note)' },
    next: { on: '2026-11-03', source: 'suggested', overdue: true, dueToday: false, reason: workflow.stage },
    unavailable: [], notConnected: ['quo', 'gmail'],
    recent: [{ at: '2026-11-02T22:11:50Z', channel: 'note', direction: 'outgoing', source: 'jobber', label: 'Outreach (Jobber note)' }],
  },
  workflow,
  loggedContacts: [],
  outreachSteps: [],
};

function renderLead() {
  return render(
    <MemoryRouter initialEntries={[`/quotes/leads/${REQ}?action=ask_info`]}>
      <Routes><Route path="/quotes/leads/:requestId" element={<LeadPage />} /></Routes>
    </MemoryRouter>,
  );
}

describe('Lead page next step', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchLead.mockResolvedValue(bundle);
    api.logLeadContact.mockResolvedValue({ contact: {} });
  });

  it('shows the one next step, the plan and what the quote will assume', async () => {
    renderLead();
    const step = await screen.findByRole('region', { name: 'Next step' });
    expect(within(step).getByText('Next step · do today')).toBeInTheDocument();
    expect(within(step).getByRole('heading', { name: 'Text: ask for photos' })).toBeInTheDocument();
    expect((within(step).getByLabelText('Proposed text') as HTMLTextAreaElement).value).toContain('Can you send a few photos of the walls?');
    expect(within(step).getByRole('link', { name: 'Text from my phone' })).toHaveAttribute('href', expect.stringMatching(/^sms:/));
    expect(within(step).queryByRole('button', { name: 'Send via Quo' })).not.toBeInTheDocument(); // Quo not connected
    expect(screen.getByText('Next contact overdue 1 day')).toBeInTheDocument();
    expect(screen.getByText('Need: photos')).toBeInTheDocument();
    const plan = screen.getByRole('region', { name: 'Follow-up plan' });
    expect(within(plan).getByText('Next day · missed')).toBeInTheDocument();
    const assume = screen.getByRole('region', { name: 'What the quote will assume' });
    expect(within(assume).getByText('about 80 ft of exterior wall.')).toBeInTheDocument();
    expect(screen.getByText(/Getting info · here/)).toBeInTheDocument();
  });

  it('Mark done logs the contact for this step and reloads', async () => {
    renderLead();
    const step = await screen.findByRole('region', { name: 'Next step' });
    await userEvent.click(within(step).getByRole('button', { name: 'Mark done' }));
    expect(api.logLeadContact).toHaveBeenCalledWith(REQ, { channel: 'text', step: 'follow_up' });
    expect(api.setLeadNextContact).not.toHaveBeenCalled(); // the date was the cadence's, nothing to clear
    await waitFor(() => expect(api.fetchLead).toHaveBeenCalledTimes(2));
  });

  it('a logged contact is not reported as failed when a hand-set date cannot be cleared', async () => {
    api.fetchLead.mockResolvedValue({ ...bundle, workflow: { ...workflow, next: { ...workflow.next, source: 'set' } } });
    api.setLeadNextContact.mockRejectedValue({ message: 'nope' });
    renderLead();
    const step = await screen.findByRole('region', { name: 'Next step' });
    await userEvent.click(within(step).getByRole('button', { name: 'Mark done' }));
    expect(await within(step).findByRole('status')).toHaveTextContent('Do not log this again');
    expect(within(step).queryByRole('alert')).not.toBeInTheDocument();
  });
});
