import { type ComponentProps, useState } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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

const pendingPayment: RepaymentRequest = {
  ...recordedPayment,
  id: 'payment-pending',
  amount: 700,
  status: 'pending',
  recordedBy: undefined,
  reviewedAt: undefined,
  reviewedBy: undefined,
}

type OpenDueCardProps = ComponentProps<typeof OpenDueCard>

function TestDueCard(props: Omit<OpenDueCardProps, 'expanded' | 'onToggle'>) {
  const [expanded, setExpanded] = useState(false)
  return <OpenDueCard {...props} expanded={expanded} onToggle={() => setExpanded((open) => !open)} />
}

function TestDueAccordion() {
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null)
  const entries = [entry, { ...entry, id: 'due-dinner', occasion: 'Dinner' }]

  return (
    <div className="drawer-entries">
      {entries.map((item) => (
        <OpenDueCard
          key={item.id}
          entry={item}
          direction="receivable"
          expanded={expandedEntryId === item.id}
          repayments={[]}
          reviews={[]}
          resolvingReviewId={null}
          resolvingRepaymentId={null}
          onEditDue={() => {}}
          onDeleteDue={() => {}}
          onOpenSplit={() => {}}
          onRequestReview={() => {}}
          onResolveReview={() => {}}
          onRecordPayment={() => {}}
          onResolveRepayment={() => {}}
          onToggle={() => setExpandedEntryId((current) => current === item.id ? null : item.id)}
        />
      ))}
    </div>
  )
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

    expect(screen.getByText('Receiver screenshot')).toBeTruthy()
    expect(screen.getByText(/Optional · 1 screenshot maximum/)).toBeTruthy()
    expect((screen.getByLabelText('Upload receiver screenshot') as HTMLInputElement).multiple).toBe(false)
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

    expect(screen.getByText('Payer screenshot')).toBeTruthy()
    expect((screen.getByLabelText('Upload payer screenshot') as HTMLInputElement).multiple).toBe(false)
    expect(screen.getByRole('button', { name: 'Add screenshots' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Add screenshot showing completed payment/i })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Send for approval' }))

    expect(screen.getByRole('alert').textContent).toContain('Add at least one')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('rejects amounts smaller than one paise precision', async () => {
    vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const onSend = vi.fn()
    const user = userEvent.setup()
    render(<RepaymentModal entry={entry} mode="record" onClose={vi.fn()} onSend={onSend} />)

    await user.clear(screen.getByRole('textbox', { name: /amount paid/i }))
    await user.type(screen.getByRole('textbox', { name: /amount paid/i }), '10.001')
    await user.click(screen.getByRole('button', { name: 'Save payment' }))

    expect(screen.getByRole('alert').textContent).toContain('two decimal places')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('prevents choosing a future payment date', async () => {
    vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const user = userEvent.setup()
    render(<RepaymentModal entry={entry} mode="record" onClose={vi.fn()} onSend={vi.fn()} />)

    const now = new Date()
    const selectedLabel = now.toLocaleDateString('en-GB')
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const tomorrowLabel = new Intl.DateTimeFormat('en-IN', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(tomorrow)

    await user.click(screen.getByRole('button', { name: selectedLabel }))
    expect(screen.getByRole('button', { name: tomorrowLabel }).hasAttribute('disabled')).toBe(true)
  })
})

describe('compact due card', () => {
  it('keeps only one due card expanded', async () => {
    const user = userEvent.setup()
    const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo })

    try {
      render(<TestDueAccordion />)

      const movieSummary = screen.getByRole('button', { name: /Movie/ })
      const dinnerSummary = screen.getByRole('button', { name: /Dinner/ })

      await user.click(movieSummary)
      expect(movieSummary.getAttribute('aria-expanded')).toBe('true')
      expect(dinnerSummary.getAttribute('aria-expanded')).toBe('false')
      await waitFor(() => expect(scrollTo).toHaveBeenCalled())

      scrollTo.mockClear()
      await user.click(dinnerSummary)
      expect(movieSummary.getAttribute('aria-expanded')).toBe('false')
      expect(dinnerSummary.getAttribute('aria-expanded')).toBe('true')
      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' })))

      await user.click(dinnerSummary)
      expect(dinnerSummary.getAttribute('aria-expanded')).toBe('false')
    } finally {
      if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo)
      else delete (HTMLElement.prototype as HTMLElement & { scrollTo?: unknown }).scrollTo
    }
  })

  it('uses one borrower payment action for full or partial payments', async () => {
    const user = userEvent.setup()
    render(
      <TestDueCard
        entry={entry}
        direction="payable"
        repayments={[]}
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
    const card = summary.closest('article')
    expect(card?.classList.contains('is-expanded')).toBe(false)

    await user.click(summary)
    expect(card?.classList.contains('is-expanded')).toBe(true)
    expect(screen.getAllByRole('button', { name: 'Record payment' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Already paid' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Report issue' })).toBeTruthy()

    await user.click(summary)
    expect(card?.classList.contains('is-expanded')).toBe(false)
  })

  it('mounts history only after due expands and labels lender records correctly', async () => {
    const user = userEvent.setup()
    render(
      <TestDueCard
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
    expect(screen.queryByRole('button', { name: /Delete Movie due/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: /Transaction history/ }))
    expect(screen.getByText('Recorded')).toBeTruthy()
  })

  it('blocks conflicting actions while a borrower payment awaits review', async () => {
    const user = userEvent.setup()
    render(
      <TestDueCard
        entry={{ ...entry, pendingRepaymentId: pendingPayment.id }}
        direction="payable"
        repayments={[pendingPayment]}
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

    await user.click(screen.getByRole('button', { name: /Movie/ }))
    expect(screen.queryByRole('button', { name: 'Record payment' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Already paid' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Report issue' })).toBeNull()
  })

  it('keeps rejection available but disables an over-balance approval', async () => {
    const user = userEvent.setup()
    render(
      <TestDueCard
        entry={{ ...entry, pendingRepaymentId: pendingPayment.id }}
        direction="receivable"
        repayments={[pendingPayment]}
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

    await user.click(screen.getByRole('button', { name: /Movie/ }))
    await user.click(screen.getByRole('button', { name: /Offline friend/ }))
    expect(screen.getByText(/Only ₹600 remains/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reject' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: 'Accept payment' }).hasAttribute('disabled')).toBe(true)
  })
})
