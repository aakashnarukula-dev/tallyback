import { LedgerEntry, LedgerEntryStatus } from './data'

const moneyPrecision = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100

export function entryOriginalAmount(entry: Pick<LedgerEntry, 'amount' | 'originalAmount'>) {
  return moneyPrecision(entry.originalAmount ?? entry.amount)
}

export function entryPaidAmount(entry: Pick<LedgerEntry, 'amount' | 'originalAmount' | 'paidAmount' | 'remainingAmount' | 'status'>) {
  const original = entryOriginalAmount(entry)
  if (entry.status === 'paid' || entry.status === 'settled') return original
  if (typeof entry.paidAmount === 'number') return moneyPrecision(Math.max(0, Math.min(entry.paidAmount, original)))
  if (typeof entry.remainingAmount === 'number') return moneyPrecision(Math.max(0, original - entry.remainingAmount))
  return 0
}

export function entryRemainingAmount(entry: Pick<LedgerEntry, 'amount' | 'originalAmount' | 'paidAmount' | 'remainingAmount' | 'status'>) {
  if (entry.status === 'paid' || entry.status === 'settled') return 0
  if (typeof entry.remainingAmount === 'number') return moneyPrecision(Math.max(0, entry.remainingAmount))
  return moneyPrecision(Math.max(0, entryOriginalAmount(entry) - entryPaidAmount(entry)))
}

export function canonicalEntryStatus(entry: Pick<LedgerEntry, 'amount' | 'originalAmount' | 'paidAmount' | 'remainingAmount' | 'status'>): Exclude<LedgerEntryStatus, 'settled'> {
  const remaining = entryRemainingAmount(entry)
  if (remaining <= 0 || entry.status === 'paid' || entry.status === 'settled') return 'paid'
  return entryPaidAmount(entry) > 0 ? 'partially_paid' : 'open'
}

export function isPaidEntry(entry: Pick<LedgerEntry, 'amount' | 'originalAmount' | 'paidAmount' | 'remainingAmount' | 'status'>) {
  return canonicalEntryStatus(entry) === 'paid'
}

export function applyApprovedPayment(
  entry: Pick<LedgerEntry, 'amount' | 'originalAmount' | 'paidAmount' | 'remainingAmount' | 'status'>,
  paymentAmount: number,
) {
  const originalAmount = entryOriginalAmount(entry)
  const currentPaid = entryPaidAmount(entry)
  const currentRemaining = entryRemainingAmount(entry)
  const amount = moneyPrecision(paymentAmount)
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Payment amount must be greater than zero.')
  if (amount > currentRemaining) throw new Error('Payment amount cannot exceed remaining due.')

  const paidAmount = moneyPrecision(currentPaid + amount)
  const remainingAmount = moneyPrecision(Math.max(0, originalAmount - paidAmount))
  return {
    originalAmount,
    paidAmount,
    remainingAmount,
    status: remainingAmount === 0 ? 'paid' as const : 'partially_paid' as const,
  }
}

export function applyRepaymentDecision(
  entry: Pick<LedgerEntry, 'amount' | 'originalAmount' | 'paidAmount' | 'remainingAmount' | 'status'>,
  paymentAmount: number,
  decision: 'accepted' | 'rejected',
) {
  if (decision === 'rejected') {
    return {
      originalAmount: entryOriginalAmount(entry),
      paidAmount: entryPaidAmount(entry),
      remainingAmount: entryRemainingAmount(entry),
      status: canonicalEntryStatus(entry),
    }
  }
  return applyApprovedPayment(entry, paymentAmount)
}

export function outstandingTotals(entries: LedgerEntry[], phone: string) {
  const normalizedPhone = phone.replace(/\D/g, '').slice(-10)
  return entries.reduce((totals, entry) => {
    const remaining = entryRemainingAmount(entry)
    if (remaining <= 0) return totals
    if (entry.lender.phone.replace(/\D/g, '').slice(-10) === normalizedPhone) totals.receivable += remaining
    if (entry.borrower.phone.replace(/\D/g, '').slice(-10) === normalizedPhone) totals.payable += remaining
    return totals
  }, { receivable: 0, payable: 0 })
}
