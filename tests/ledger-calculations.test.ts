import { describe, expect, it } from 'vitest'
import { LedgerEntry } from '../src/data'
import {
  applyApprovedPayment,
  applyRepaymentDecision,
  entryRemainingAmount,
  isPaidEntry,
  outstandingTotals,
} from '../src/ledger-calculations'

const entry = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: 'due-1',
  lender: { name: 'Lender', phone: '+919177216132' },
  borrower: { name: 'Borrower', phone: '+919154195668' },
  amount: 1000,
  originalAmount: 1000,
  paidAmount: 0,
  remainingAmount: 1000,
  occasion: 'Booking',
  method: 'UPI',
  date: '2026-09-21',
  status: 'open',
  ...overrides,
})

describe('partial repayment calculations', () => {
  it('applies one partial payment without closing due', () => {
    expect(applyApprovedPayment(entry(), 400)).toEqual({
      originalAmount: 1000,
      paidAmount: 400,
      remainingAmount: 600,
      status: 'partially_paid',
    })
  })

  it('supports multiple partial payments until remaining amount reaches zero', () => {
    const first = applyApprovedPayment(entry(), 400)
    const second = applyApprovedPayment(entry(first), 250)
    const final = applyApprovedPayment(entry(second), 350)

    expect(second).toMatchObject({ paidAmount: 650, remainingAmount: 350, status: 'partially_paid' })
    expect(final).toMatchObject({ paidAmount: 1000, remainingAmount: 0, status: 'paid' })
  })

  it('keeps repeated decimal payments at paise precision', () => {
    const decimalDue = entry({ amount: 0.3, originalAmount: 0.3, remainingAmount: 0.3 })
    const first = applyApprovedPayment(decimalDue, 0.1)
    const final = applyApprovedPayment(entry({ ...decimalDue, ...first }), 0.2)

    expect(first).toMatchObject({ paidAmount: 0.1, remainingAmount: 0.2, status: 'partially_paid' })
    expect(final).toMatchObject({ paidAmount: 0.3, remainingAmount: 0, status: 'paid' })
  })

  it('rejects zero and overpayment amounts', () => {
    expect(() => applyApprovedPayment(entry(), 0)).toThrow('greater than zero')
    expect(() => applyApprovedPayment(entry(), 1001)).toThrow('cannot exceed remaining due')
  })

  it('rejects sub-paise payment amounts instead of silently rounding them', () => {
    expect(() => applyApprovedPayment(entry(), 0.009)).toThrow('two decimal places')
    expect(() => applyApprovedPayment(entry(), 10.001)).toThrow('two decimal places')
  })

  it('updates balance only for accepted requests', () => {
    expect(applyRepaymentDecision(entry(), 400, 'rejected')).toEqual({
      originalAmount: 1000,
      paidAmount: 0,
      remainingAmount: 1000,
      status: 'open',
    })
    expect(applyRepaymentDecision(entry(), 400, 'accepted')).toMatchObject({
      paidAmount: 400,
      remainingAmount: 600,
      status: 'partially_paid',
    })
  })
})

describe('paid history and totals', () => {
  it('retains original amount while paid due has zero remaining', () => {
    const paid = entry({ paidAmount: 1000, remainingAmount: 0, status: 'paid' })
    expect(isPaidEntry(paid)).toBe(true)
    expect(paid.amount).toBe(1000)
    expect(entryRemainingAmount(paid)).toBe(0)
  })

  it('excludes paid amount from totals and counts only remaining partial balance', () => {
    const open = entry({ id: 'open', amount: 300, originalAmount: 300, remainingAmount: 300 })
    const partial = entry({ id: 'partial', paidAmount: 400, remainingAmount: 600, status: 'partially_paid' })
    const paid = entry({ id: 'paid', paidAmount: 1000, remainingAmount: 0, status: 'paid' })

    expect(outstandingTotals([open, partial, paid], '+919177216132')).toEqual({ receivable: 900, payable: 0 })
    expect(outstandingTotals([open, partial, paid], '+919154195668')).toEqual({ receivable: 0, payable: 900 })
  })
})
