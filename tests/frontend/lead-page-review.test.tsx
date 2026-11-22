import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LeadPage from '../../client/src/pages/LeadPage';
import type { LeadBundle, LeadReviewDetail, LeadWorkflow } from '../../client/src/api';

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
  requestQuoteReview: vi.fn(),
  createLeadDraft: vi.fn(),
  fetchLeadDraft: vi.fn().mockResolvedValue({ draftId: null }),
  closeLead: vi.fn(),
  reopenLead: vi.fn(),
  syncLeadTrello: vi.fn(),
  LEAD_CLOSE_REASONS: [
    { value: 'went_elsewhere', label: 'Went with someone else' },
    { value: 'too_small', label: 'Too small or not our work' },
    { value: 'no_response', label: 'No response' },
    { value: 'postponed', label: 'Postponed' },
    { value: 'other', label: 'Other' },
  ],
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
    items: [],
    summary: { total: 0, open: 0, asked: 0, answered: 0, readyToQuote: false },
  },
  contactStatus: {
    last: null,
    next: { on: '2026-11-03', source: 'suggested', overdue: true, dueToday: false, reason: workflow.stage },
    unavailable: [], notConnected: ['quo', 'gmail'],
    recent: [],
  },
  workflow,
  loggedContacts: [],
  outreachSteps: [],
};

function withReview(review: LeadReviewDetail | null): LeadBundle {
  return {
    ...bundle,
    workflow: {
      ...workflow,
      quoteStage: { kind: 'changes', quote: { id: 'q1', number: '12', webUri: null }, label: 'With Ben', why: 'Waiting on Ben.', review },
    },
  };
}

function renderLead() {
  return render(
    <MemoryRouter initialEntries={[`/quotes/leads/${REQ}`]}>
      <Routes><Route path="/quotes/leads/:requestId" element={<LeadPage />} /></Routes>
    </MemoryRouter>,
  );
}

describe("Lead page Ben's review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchLead.mockResolvedValue(bundle);
    api.logLeadContact.mockResolvedValue({ contact: {} });
  });

  it("shows Ben's review under the quote: the decision, his edits, the summary and the Open review link", async () => {
    api.fetchLead.mockResolvedValue(withReview({
      at: '2026-11-04T12:00:00Z',
      decision: 'changes_requested',
      summary: 'short summary',
      requestedEdits: ['Drop tool rental', 'Add sub rate'],
      artifactUrl: 'https://claude.ai/artifact/abc',
    }));
    renderLead();
    const box = await screen.findByLabelText("Ben's review");
    expect(within(box).getByText("Ben's review · Changes requested")).toBeInTheDocument();
    expect(within(box).getByText('Drop tool rental')).toBeInTheDocument();
    expect(within(box).getByText('Add sub rate')).toBeInTheDocument();
    expect(within(box).getByText('short summary')).toBeInTheDocument();
    const link = within(box).getByRole('link', { name: 'Open review' });
    expect(link).toHaveAttribute('href', 'https://claude.ai/artifact/abc');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('shows no review box when the quote has no review record', async () => {
    api.fetchLead.mockResolvedValue(withReview(null));
    renderLead();
    await screen.findByRole('region', { name: 'Next step' });
    expect(screen.queryByText(/Ben's review/)).not.toBeInTheDocument();
  });

  it('expands a summary past six lines with Show more and collapses it again', async () => {
    const summary = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join('\n');
    api.fetchLead.mockResolvedValue(withReview({
      at: '2026-11-04T12:00:00Z',
      decision: 'approved',
      summary,
      requestedEdits: [],
      artifactUrl: null,
    }));
    renderLead();
    const box = await screen.findByLabelText("Ben's review");
    expect(within(box).queryByText(/Line 10/)).not.toBeInTheDocument();
    await userEvent.click(within(box).getByRole('button', { name: 'Show more' }));
    expect(within(box).getByText(/Line 10/)).toBeInTheDocument();
    await userEvent.click(within(box).getByRole('button', { name: 'Show less' }));
    expect(within(box).queryByText(/Line 10/)).not.toBeInTheDocument();
  });
});
