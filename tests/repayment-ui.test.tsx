import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenDueCard, RepaymentModal } from '../src/App'
import { LedgerEntry, RepaymentRequest } from '../src/data'

const entry: LedgerEntry = {
  id: 'due-compact',
  lender: { name: 'Aakash', phone: '+919177216132' },
  borrower: { name: 'Offline friend', phone: '+919154195669' },
  amount: 1000,
  originalAmount: 1000,
  paidAmount: 400,
  remainingAmount: 600,
  occasion: 'Movie',
  method: 'UPI',
  date: '2026-09-21',
  status: 'partially_paid',
  createdBy: 'lender-id',
}

const recordedPayment: RepaymentRequest = {
  id: 'payment-400',
  dueId: entry.id,
  lenderId: 'lender-id',
  lenderPhone: entry.lender.phone,
  borrowerPhone: entry.borrower.phone,
  participantPhones: [entry.lender.phone, entry.borrower.phone],
  payerName: entry.borrower.name,
  amount: 400,
  method: 'Cash',
  paidAt: '2026-09-21',
  proofScreenshots: [],
  note: 'Received offline',
  status: 'accepted',
  recordedBy: 'lender',
  createdAt: new Date('2026-09-21T10:00:00Z'),
  reviewedAt: new Date('2026-09-21T10:00:00Z'),
  reviewedBy: 'lender-id',
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.replaceState({}, '', '/')
})

describe('record payment sheet', () => {
  it('lets lender save partial payment without proof', async () => {
    vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const onSend = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<RepaymentModal entry={entry} mode="record" onClose={vi.fn()} onSend={onSend} />)

    expect(screen.getByText(/Optional · up to 5 screenshots/)).toBeTruthy()
    expect(document.activeElement).not.toBe(screen.getByRole('textbox', { name: /note/i }))
    await user.clear(screen.getByRole('textbox', { name: /amount paid/i }))
    await user.type(screen.getByRole('textbox', { name: /amount paid/i }), '250')
    await user.click(screen.getByRole('button', { name: 'Save payment' }))

    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ amount: 250, proofFiles: [] }))
  })

  it('keeps proof mandatory for borrower approval requests', async () => {
    vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const onSend = vi.fn()
    const user = userEvent.setup()
    render(<RepaymentModal entry={entry} mode="request" onClose={vi.fn()} onSend={onSend} />)

    await user.click(screen.getByRole('button', { name: 'Send for approval' }))

    expect(screen.getByRole('alert').textContent).toContain('Add at least one')
    expect(onSend).not.toHaveBeenCalled()
  })
})

describe('compact due card', () => {
  it('mounts history only after due expands and labels lender records correctly', async () => {
    const user = userEvent.setup()
    render(
      <OpenDueCard
        entry={entry}
        direction="receivable"
        repayments={[recordedPayment]}
        reviews={[]}
        resolvingReviewId={null}
        resolvingRepaymentId={null}
        onEditDue={vi.fn()}
        onDeleteDue={vi.fn()}
        onOpenSplit={vi.fn()}
        onRequestReview={vi.fn()}
        onResolveReview={vi.fn()}
        onRecordPayment={vi.fn()}
        onResolveRepayment={vi.fn()}
      />,
    )

    const summary = screen.getByRole('button', { name: /Movie/ })
    expect(summary.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Transaction history')).toBeNull()
    expect(screen.queryByText('Received offline')).toBeNull()

    await user.click(summary)
    expect(screen.getByText('Transaction history')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /Transaction history/ }))
    expect(screen.getByText('Recorded')).toBeTruthy()
  })
})
