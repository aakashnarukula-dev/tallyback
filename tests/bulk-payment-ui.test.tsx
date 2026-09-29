import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BulkPaymentModal } from '../src/App'
import { LedgerEntry } from '../src/data'

const due = (id: string, occasion: string, amount: number, date: string): LedgerEntry => ({
  id,
  lender: { name: 'Aakash', phone: '+919177216132' },
  borrower: { name: 'Surya', phone: '+919154195668' },
  amount,
  originalAmount: amount,
  paidAmount: 0,
  remainingAmount: amount,
  occasion,
  method: 'UPI',
  date,
  status: 'open',
  createdBy: 'lender-id',
})

const dues = [
  due('card', 'Credit card payment', 8000, '2026-06-19'),
  due('gsv-1', 'GSV Infratech A', 50000, '2026-08-03'),
  due('gift', 'Kishore Gift Share', 2000, '2026-08-19'),
  due('gsv-2', 'GSV Infratech B', 50000, '2026-08-20'),
  due('phonepe', 'Phonepe', 60000, '2026-08-21'),
]

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('record payment across dues', () => {
  it('splits one offline payment over the ticked dues and reduces the last one', async () => {
    vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<BulkPaymentModal person={dues[0].borrower} dues={dues} onClose={vi.fn()} onSave={onSave} />)

    expect((screen.getByRole('checkbox', { name: /Credit card payment/ }) as HTMLInputElement).disabled).toBe(true)
    await user.type(screen.getByRole('textbox', { name: /amount received/i }), '70000')
    for (const name of [/Credit card payment/, /GSV Infratech A/, /Kishore Gift Share/, /GSV Infratech B/]) {
      await user.click(screen.getByRole('checkbox', { name }))
    }

    expect((screen.getByRole('checkbox', { name: /Phonepe/ }) as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText('Amount fully assigned')).toBeTruthy()
    expect(screen.getByText(/₹10,000 paid · ₹40,000 left/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Save across 4 dues' }))

    const submission = onSave.mock.calls[0][0]
    expect(submission.totalAmount).toBe(70000)
    expect(submission.proofFile).toBeNull()
    expect(submission.allocations.map(({ entry, amount }: { entry: LedgerEntry; amount: number }) => [entry.id, amount])).toEqual([
      ['card', 8000],
      ['gsv-1', 50000],
      ['gift', 2000],
      ['gsv-2', 10000],
    ])
    expect(submission.allocations[3].note).toContain('₹10,000 already paid, ₹40,000 left')
    expect(submission.allocations[0].note).toBe('Part of ₹70,000 offline payment')
  })

  it('asks for more dues when the amount is not fully assigned', async () => {
    vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const onSave = vi.fn()
    const user = userEvent.setup()
    render(<BulkPaymentModal person={dues[0].borrower} dues={dues} onClose={vi.fn()} onSave={onSave} />)

    await user.type(screen.getByRole('textbox', { name: /amount received/i }), '10000')
    await user.click(screen.getByRole('checkbox', { name: /Credit card payment/ }))
    await user.click(screen.getByRole('button', { name: 'Save payment' }))

    expect(screen.getByRole('alert').textContent).toContain('₹2,000 is not assigned yet')
    expect(onSave).not.toHaveBeenCalled()
  })
})
