export type Person = {
  name: string
  phone: string
}

export type SavedContact = Person & {
  source: 'device' | 'manual'
}

export type PaymentMethod =
  | 'UPI'
  | 'Credit card'
  | 'Cash'
  | 'Bank transfer'
  | 'Personal funds'

export type PaymentScreenshot = {
  path: string
  name: string
  contentType: string
  size: number
}

export type LedgerEntryStatus = 'open' | 'partially_paid' | 'paid' | 'settled'

export type LedgerEntry = {
  id: string
  lender: Person
  borrower: Person
  amount: number
  originalAmount?: number
  paidAmount?: number
  remainingAmount?: number
  occasion: string
  method: PaymentMethod
  date: string
  status: LedgerEntryStatus
  settledAt?: string
  createdBy?: string
  createdAt?: unknown
  updatedAt?: unknown
  lastRepaymentId?: string
  review?: LedgerReview
  screenshots?: PaymentScreenshot[]
}

export type RepaymentRequestStatus = 'pending' | 'accepted' | 'rejected'

export type RepaymentRequest = {
  id: string
  dueId: string
  lenderId: string
  lenderPhone: string
  borrowerId?: string
  borrowerPhone: string
  participantPhones: string[]
  payerName: string
  amount: number
  method: PaymentMethod
  paidAt: string
  proofScreenshots: PaymentScreenshot[]
  note: string
  status: RepaymentRequestStatus
  createdAt?: unknown
  reviewedAt?: unknown
  reviewedBy?: string
  recordedBy?: 'lender'
}

export type LedgerActivityType =
  | 'due_created'
  | 'due_edited'
  | 'repayment_submitted'
  | 'repayment_accepted'
  | 'repayment_rejected'
  | 'payment_recorded'
  | 'mistake_reported'
  | 'correction_accepted'
  | 'correction_rejected'
  | 'due_marked_paid'

export type LedgerActivity = {
  id: string
  dueId: string
  sourceId: string
  type: LedgerActivityType
  actorUid: string
  actorPhone: string
  actorName: string
  lender: Person
  borrower: Person
  lenderPhone: string
  borrowerPhone: string
  participantPhones: string[]
  amount: number
  eventDate: string
  method: PaymentMethod
  note: string
  status: 'open' | 'partially_paid' | 'paid' | 'pending' | 'accepted' | 'rejected'
  occurredAt?: unknown
}

export type SplitLedgerReference = {
  splitId: string
  recipientId: string
}

export const getSplitLedgerReference = (entryId: string): SplitLedgerReference | null => {
  if (!entryId.startsWith('split-')) return null
  const recipientMarker = entryId.lastIndexOf('-member-')
  if (recipientMarker <= 'split-'.length) return null
  return {
    splitId: entryId.slice('split-'.length, recipientMarker),
    recipientId: entryId.slice(recipientMarker + 1),
  }
}

export type ReviewKind = 'amount' | 'paid'

export type LedgerReview = {
  reviewId?: string
  requestedByUid: string
  requestedByPhone: string
  kind: ReviewKind
  proposedAmount: number
  proposedMethod?: PaymentMethod
  proposedOccasion?: string
  proposedDate?: string
  note: string
  proofScreenshots?: PaymentScreenshot[]
  status: 'pending'
  createdAt?: unknown
  updatedAt?: unknown
}

export type LedgerReviewStatus = 'pending' | 'approved' | 'rejected'

export type LedgerReviewRecord = {
  id: string
  entryId: string
  entryCreatedBy: string
  lender: Person
  borrower: Person
  lenderPhone: string
  borrowerPhone: string
  participantPhones: string[]
  requestedByUid: string
  requestedByPhone: string
  resolvedByUid?: string
  kind: ReviewKind
  originalAmount: number
  originalMethod: PaymentMethod
  originalOccasion: string
  originalDate: string
  proposedAmount: number
  proposedMethod: PaymentMethod
  proposedOccasion: string
  proposedDate: string
  note: string
  proofScreenshots: PaymentScreenshot[]
  status: LedgerReviewStatus
  createdAt?: unknown
  resolvedAt?: unknown
  updatedAt?: unknown
}

export const AVATAR_COLORS = [
  '#dfe6ff',
  '#d9f4e8',
  '#fee3d9',
  '#f2def8',
  '#ffedc8',
  '#d9eff4',
]

export const normalizePhone = (phone: string) => phone.replace(/\D/g, '').slice(-10)

export const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()

export const avatarColor = (phone: string) => {
  const value = normalizePhone(phone)
    .split('')
    .reduce((sum, digit) => sum + Number(digit), 0)
  return AVATAR_COLORS[value % AVATAR_COLORS.length]
}
