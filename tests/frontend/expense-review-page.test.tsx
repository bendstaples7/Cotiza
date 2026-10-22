import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ExpenseReviewPage from '../../client/src/pages/ExpenseReviewPage';
vi.mock('../../client/src/api', () => ({ API_BASE: 'https://api.example', getToken: () => 'session' }));
const id = '11111111-1111-4111-8111-111111111111';
const details = { supplier: '20four7VA', invoiceNumber: '5511-R-0023', title: 'Weekly VA support', description: '30 hours plus fees', date: '2026-10-22', total: 216.20 };
const review = { state: 'pending', expiresAt: '2099-01-01', receiptSource: 'square_invoice', details };
function mount() { return render(<MemoryRouter initialEntries={[`/expenses/review/${id}`]}><Routes><Route path="/expenses/review/:id" element={<ExpenseReviewPage />} /></Routes></MemoryRouter>); }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('expense review confirmation', () => {
  it('shows the amount and attachment limitation and submits once after approval', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(review))).mockResolvedValueOnce(new Response(JSON.stringify({ outcome: 'created', receiptSubmitted: true })));
    vi.stubGlobal('fetch', fetchMock); mount();
    expect(await screen.findByText('$216.20')).toBeInTheDocument();
    expect(screen.getByText(/does not let us reopen/)).toBeInTheDocument();
    const approve = screen.getByRole('button', { name: 'Approve and record expense' });
    await waitFor(() => expect(approve).toBeEnabled()); fireEvent.click(approve); fireEvent.click(approve);
    expect(await screen.findByText('Submission accepted')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('requires explicit confirmation before replacing an existing receipt', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ...review, details: { ...details, operation: 'attach', targetExpenseId: 'expense-123' } }))).mockResolvedValueOnce(new Response(JSON.stringify({ outcome: 'receipt_submitted' })));
    vi.stubGlobal('fetch', fetchMock); mount();
    const approve = await screen.findByRole('button', { name: 'Approve receipt submission' });
    expect(approve).toBeDisabled(); fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(approve).toBeEnabled()); fireEvent.click(approve);
    await screen.findByText('Submission accepted');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ confirmReplacement: true });
  });
  it('does not offer a retry after an interrupted write', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(review))).mockRejectedValueOnce(new Error('network'));
    vi.stubGlobal('fetch', fetchMock); mount();
    const approve = await screen.findByRole('button', { name: 'Approve and record expense' });
    await waitFor(() => expect(approve).toBeEnabled()); fireEvent.click(approve);
    expect(await screen.findByText(/Do not submit again/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve and record expense' })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('keeps approval disabled if a selected category cannot be confirmed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ...review, details: { ...details, accountingCodeId: 'category123' } }))).mockResolvedValueOnce(new Response(JSON.stringify({ outcome: 'unavailable' })))); mount();
    await screen.findByText(/could not be confirmed/);
    expect(screen.getByRole('button', { name: 'Approve and record expense' })).toBeDisabled();
  });
});
