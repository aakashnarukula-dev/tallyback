export type Person = {
  name: string
  phone: string
}

export type PaymentMethod =
  | 'UPI'
  | 'Credit card'
  | 'Cash'
  | 'Bank transfer'
  | 'Personal funds'

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
}

export type ReviewKind = 'amount' | 'paid'

export type LedgerReview = {
  id: string
  entryId: string
  participantPhones: string[]
  lenderPhone: string
  borrowerPhone: string
  requestedByUid: string
  requestedByPhone: string
  kind: ReviewKind
  proposedAmount: number
  note: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt?: unknown
  updatedAt?: unknown
  resolvedAt?: unknown
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
