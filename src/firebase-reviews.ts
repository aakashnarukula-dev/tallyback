import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
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

export function subscribeToReviews(
  phone: string,
  onReviews: (reviews: LedgerReview[]) => void,
  onError: (error: Error) => void,
) {
  const reviewsQuery = query(
    collection(requireDatabase(), 'ledgerReviews'),
    where('participantPhones', 'array-contains', toE164(phone)),
  )

  return onSnapshot(reviewsQuery, (snapshot) => {
    onReviews(snapshot.docs.map((reviewDoc) => ({
      ...(reviewDoc.data() as Omit<LedgerReview, 'id'>),
      id: reviewDoc.id,
    })))
  }, onError)
}

export async function createReviewRequest(entry: LedgerEntry, uid: string, draft: ReviewDraft) {
  const lenderPhone = toE164(entry.lender.phone)
  const borrowerPhone = toE164(entry.borrower.phone)
  const random = crypto.randomUUID?.().replace(/-/g, '').slice(0, 12) || Math.random().toString(36).slice(2, 14)
  const reviewId = `review-${entry.id}-${random}`.slice(0, 220)

  await setDoc(doc(requireDatabase(), 'ledgerReviews', reviewId), {
    entryId: entry.id,
    participantPhones: [lenderPhone, borrowerPhone],
    lenderPhone,
    borrowerPhone,
    requestedByUid: uid,
    requestedByPhone: borrowerPhone,
    kind: draft.kind,
    proposedAmount: draft.kind === 'amount' ? draft.proposedAmount : 0,
    note: draft.note.trim().slice(0, 280),
    status: 'pending',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
}

export async function resolveReviewRequest(
  review: LedgerReview,
  entry: LedgerEntry,
  decision: 'approved' | 'rejected',
) {
  const database = requireDatabase()
  const batch = writeBatch(database)

  if (decision === 'approved') {
    if (review.kind === 'amount') {
      batch.update(doc(database, 'ledgerEntries', entry.id), {
        amount: review.proposedAmount,
        updatedAt: serverTimestamp(),
      })
    } else {
      batch.update(doc(database, 'ledgerEntries', entry.id), {
        status: 'settled',
        settledAt: new Date().toISOString(),
        updatedAt: serverTimestamp(),
      })
    }
  }

  batch.update(doc(database, 'ledgerReviews', review.id), {
    status: decision,
    resolvedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  await batch.commit()
}
