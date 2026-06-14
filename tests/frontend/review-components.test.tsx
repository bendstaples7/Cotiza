import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ReviewBadge from '../../client/src/components/review/ReviewBadge';
import PushToJobberButton from '../../client/src/components/review/PushToJobberButton';
import ReviewLineItemFeedbackPanel from '../../client/src/components/review/ReviewLineItemFeedbackPanel';
import ReviewQueuePage from '../../client/src/pages/ReviewQueuePage';
import type { QuoteLineItem } from 'shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetPendingReviews = vi.hoisted(() => vi.fn<() => Promise<any[]>>());
const mockAddFeedback = vi.hoisted(() => vi.fn<() => Promise<{ feedbackId: string; createdAt: string }>>());

vi.mock('../../client/src/api', () => ({
  getPendingReviews: mockGetPendingReviews,
  addFeedback: mockAddFeedback,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLineItem(overrides: Partial<QuoteLineItem> = {}): QuoteLineItem {
  return {
    id: 'li-1',
    productName: 'Drywall Installation',
    description: 'Install drywall for living room',
    quantity: 1200,
    unitPrice: 8.50,
    confidenceScore: 0.95,
    originalText: 'drywall installation',
    resolved: true,
    productCatalogEntryId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// T-5.4.1: ReviewBadge
// ---------------------------------------------------------------------------

describe('ReviewBadge', () => {
  it('renders nothing for null status', () => {
    const { container } = render(<ReviewBadge status={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing for "none" status', () => {
    const { container } = render(<ReviewBadge status="none" />);
    expect(container.innerHTML).toBe('');
  });

  it('renders "Pending Review" with purple styling', () => {
    render(<ReviewBadge status="pending_review" />);
    const badge = screen.getByText('Pending Review');
    expect(badge).toBeInTheDocument();
    // purple-ish background
    expect(badge.getAttribute('style')).toContain('ede9fe');
    expect(badge.getAttribute('style')).toContain('7c3aed');
  });

  it('renders "Changes Requested" with orange styling', () => {
    render(<ReviewBadge status="changes_requested" />);
    const badge = screen.getByText('Changes Requested');
    expect(badge).toBeInTheDocument();
    expect(badge.getAttribute('style')).toContain('fff7ed');
    expect(badge.getAttribute('style')).toContain('ea580c');
  });

  it('renders "Pushed to Jobber" with green styling', () => {
    render(<ReviewBadge status="push_to_jobber" />);
    const badge = screen.getByText('Pushed to Jobber');
    expect(badge).toBeInTheDocument();
    expect(badge.getAttribute('style')).toContain('f0fdf4');
    expect(badge.getAttribute('style')).toContain('16a34a');
  });

  it('has inline-flex display and pill shape', () => {
    render(<ReviewBadge status="pending_review" />);
    const badge = screen.getByText('Pending Review');
    expect(badge.getAttribute('style')).toContain('inline-flex');
    expect(badge.getAttribute('style')).toContain('999px'); // borderRadius
  });
});

// ---------------------------------------------------------------------------
// T-5.4.2: PushToJobberButton
// ---------------------------------------------------------------------------

describe('PushToJobberButton', () => {
  const mockOnPush = vi.fn<() => Promise<void>>();
  const mockOnRequestChanges = vi.fn<() => Promise<void>>();

  beforeEach(() => {
    vi.clearAllMocks();
    mockOnPush.mockResolvedValue(undefined);
    mockOnRequestChanges.mockResolvedValue(undefined);
  });

  it('renders initial buttons', () => {
    render(
      <PushToJobberButton
        onPush={mockOnPush}
        onRequestChanges={mockOnRequestChanges}
      />,
    );
    expect(screen.getByText('🚀 Push to Jobber')).toBeInTheDocument();
    expect(screen.getByText('Request Changes')).toBeInTheDocument();
  });

  it('shows loading state when pushing', async () => {
    // Keep the promise pending so we see loading state
    mockOnPush.mockReturnValue(new Promise(() => {}));

    render(
      <PushToJobberButton
        onPush={mockOnPush}
        onRequestChanges={mockOnRequestChanges}
      />,
    );

    // Click push button
    const pushButton = screen.getByText('🚀 Push to Jobber');
    await userEvent.click(pushButton);

    // Confirmation dialog appears
    const confirmButton = screen.getByText('Push to Jobber');
    await userEvent.click(confirmButton);

    // Should show loading state
    await waitFor(() => {
      expect(screen.getByText('Pushing…')).toBeInTheDocument();
    });
  });

  it('shows success state after push completes', async () => {
    render(
      <PushToJobberButton
        onPush={mockOnPush}
        onRequestChanges={mockOnRequestChanges}
      />,
    );

    const pushButton = screen.getByText('🚀 Push to Jobber');
    await userEvent.click(pushButton);

    const confirmButton = screen.getByText('Push to Jobber');
    await userEvent.click(confirmButton);

    await waitFor(() => {
      expect(screen.getByText('✅ Pushed to Jobber')).toBeInTheDocument();
    });
  });

  it('shows error state when push fails', async () => {
    mockOnPush.mockRejectedValue(new Error('Jobber API unavailable'));

    render(
      <PushToJobberButton
        onPush={mockOnPush}
        onRequestChanges={mockOnRequestChanges}
      />,
    );

    const pushButton = screen.getByText('🚀 Push to Jobber');
    await userEvent.click(pushButton);

    const confirmButton = screen.getByText('Push to Jobber');
    await userEvent.click(confirmButton);

    await waitFor(() => {
      expect(screen.getByText('⚠️ Retry Push')).toBeInTheDocument();
    });

    // Error alert should be shown
    expect(screen.getByRole('alert')).toHaveTextContent('Jobber API unavailable');
  });

  it('respects pushDisabled prop', () => {
    render(
      <PushToJobberButton
        onPush={mockOnPush}
        onRequestChanges={mockOnRequestChanges}
        pushDisabled={true}
        pushTooltip="Cannot push - review not complete"
      />,
    );

    const pushButton = screen.getByText('🚀 Push to Jobber');
    expect(pushButton).toBeDisabled();
    expect(pushButton).toHaveAttribute('title', 'Cannot push - review not complete');
  });
});

// ---------------------------------------------------------------------------
// T-5.4.3: ReviewQueuePage
// ---------------------------------------------------------------------------

describe('ReviewQueuePage', () => {
  beforeEach(() => {
    mockGetPendingReviews.mockReset();
  });

  it('renders empty state when no reviews', async () => {
    mockGetPendingReviews.mockResolvedValue([]);

    render(
      <MemoryRouter>
        <ReviewQueuePage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('No quotes pending review.')).toBeInTheDocument();
  });

  it('renders loading state initially', async () => {
    mockGetPendingReviews.mockReturnValue(new Promise(() => {}));

    render(
      <MemoryRouter>
        <ReviewQueuePage />
      </MemoryRouter>,
    );

    expect(screen.getByText('Loading pending reviews…')).toBeInTheDocument();
  });

  it('renders review cards when data loaded', async () => {
    const now = new Date().toISOString();
    mockGetPendingReviews.mockResolvedValue([
      {
        id: 'review-1',
        quoteDraftId: 'draft-1',
        draftNumber: 42,
        totalValue: 15000.50,
        status: 'pending_review',
        submittedAt: now,
        reviewCycle: 1,
        submittedBy: { id: 'user-1', name: 'Alice' },
      },
      {
        id: 'review-2',
        quoteDraftId: 'draft-2',
        draftNumber: 43,
        totalValue: 8200.00,
        status: 'pending_review',
        submittedAt: now,
        reviewCycle: 2,
        submittedBy: { id: 'user-2', name: 'Bob' },
      },
    ]);

    render(
      <MemoryRouter>
        <ReviewQueuePage />
      </MemoryRouter>,
    );

    // Should show draft numbers
    expect(await screen.findByText('D-042')).toBeInTheDocument();
    expect(screen.getByText('D-043')).toBeInTheDocument();

    // Should show submitter names
    expect(screen.getByText(/Submitted by Alice/)).toBeInTheDocument();
    expect(screen.getByText(/Submitted by Bob/)).toBeInTheDocument();

    // Should show total values
    expect(screen.getByText(/\$15,000.50/)).toBeInTheDocument();
    expect(screen.getByText(/\$8,200.00/)).toBeInTheDocument();

    // Should show cycle numbers
    expect(screen.getByText('Cycle 1')).toBeInTheDocument();
    expect(screen.getByText('Cycle 2')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// T-5.4.4: ReviewLineItemFeedbackPanel
// ---------------------------------------------------------------------------

describe('ReviewLineItemFeedbackPanel', () => {
  beforeEach(() => {
    mockAddFeedback.mockReset();
    mockAddFeedback.mockResolvedValue({ feedbackId: 'fb-1', createdAt: new Date().toISOString() });
  });

  it('renders feedback for line items', () => {
    const lineItems = [makeLineItem({ id: 'li-1', productName: 'Drywall' })];
    const feedback = [
      { id: 'fb-1', lineItemId: 'li-1', fieldName: 'quantity', comment: 'Too much', createdAt: new Date().toISOString() },
    ];

    render(
      <ReviewLineItemFeedbackPanel
        lineItems={lineItems}
        feedback={feedback}
        reviewId="review-1"
      />,
    );

    expect(screen.getByText('Line Item Feedback')).toBeInTheDocument();
    expect(screen.getByText('Drywall')).toBeInTheDocument();
    expect(screen.getByText('Too much')).toBeInTheDocument();
    expect(screen.getByText('quantity')).toBeInTheDocument();
  });

  it('shows feedback count badge', () => {
    const lineItems = [makeLineItem({ id: 'li-1', productName: 'Drywall' })];
    const feedback = [
      { id: 'fb-1', lineItemId: 'li-1', fieldName: 'quantity', comment: 'Too much', createdAt: new Date().toISOString() },
      { id: 'fb-2', lineItemId: 'li-1', fieldName: 'price', comment: 'Too expensive', createdAt: new Date().toISOString() },
    ];

    render(
      <ReviewLineItemFeedbackPanel
        lineItems={lineItems}
        feedback={feedback}
        reviewId="review-1"
      />,
    );

    // Should show feedback count (2)
    expect(screen.getByText('(2)')).toBeInTheDocument();
  });

  it('shows no line items message when lineItems is empty', () => {
    render(
      <ReviewLineItemFeedbackPanel
        lineItems={[]}
        feedback={[]}
        reviewId="review-1"
      />,
    );

    expect(screen.getByText('No line items in this quote.')).toBeInTheDocument();
  });

  it('shows "Add Feedback" button when not read-only', () => {
    const lineItems = [makeLineItem({ id: 'li-1', productName: 'Drywall' })];

    render(
      <ReviewLineItemFeedbackPanel
        lineItems={lineItems}
        feedback={[]}
        reviewId="review-1"
      />,
    );

    expect(screen.getByText('Add Feedback')).toBeInTheDocument();
  });

  it('hides "Add Feedback" button when read-only', () => {
    const lineItems = [makeLineItem({ id: 'li-1', productName: 'Drywall' })];

    render(
      <ReviewLineItemFeedbackPanel
        lineItems={lineItems}
        feedback={[]}
        reviewId="review-1"
        readOnly
      />,
    );

    expect(screen.queryByText('Add Feedback')).toBeNull();
  });
});