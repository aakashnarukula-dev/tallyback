import {
  deleteField,
  doc,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore'
import { LedgerEntry, LedgerReview, ReviewKind } from './data'
import { db } from './firebase'
import { toE164 } from './firebase-ledger'

export type ReviewDraft = {
  kind: ReviewKind
  proposedAmount: number
  note: string
}

function requireDatabase() {
  if (!db) throw new Error('Firebase is not configured.')
  return db
}

export async function createReviewRequest(entry: LedgerEntry, uid: string, draft: ReviewDraft) {
  const borrowerPhone = toE164(entry.borrower.phone)

  await updateDoc(doc(requireDatabase(), 'ledgerEntries', entry.id), {
    review: {
      requestedByUid: uid,
      requestedByPhone: borrowerPhone,
      kind: draft.kind,
      proposedAmount: draft.kind === 'amount' ? draft.proposedAmount : 0,
      note: draft.note.trim().slice(0, 280),
      status: 'pending',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    updatedAt: serverTimestamp(),
  })
}

export async function resolveReviewRequest(
  review: LedgerReview,
  entry: LedgerEntry,
  decision: 'approved' | 'rejected',
) {
  const database = requireDatabase()
  const updates: Record<string, unknown> = {
    review: deleteField(),
    updatedAt: serverTimestamp(),
  }

  if (decision === 'approved') {
    if (review.kind === 'amount') {
      updates.amount = review.proposedAmount
    } else {
      updates.status = 'settled'
      updates.settledAt = new Date().toISOString()
    }
  }

  await updateDoc(doc(database, 'ledgerEntries', entry.id), updates)
}
