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

export type LedgerEntry = {
  id: string
  lender: Person
  borrower: Person
  amount: number
  occasion: string
  method: PaymentMethod
  date: string
  status: 'open' | 'settled'
  settledAt?: string
  createdBy?: string
  review?: LedgerReview
  screenshots?: PaymentScreenshot[]
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
