import {
  collection,
  deleteField,
  doc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  writeBatch,
  updateDoc,
  where,
} from 'firebase/firestore'
import { getSplitLedgerReference, LedgerEntry, LedgerReview, LedgerReviewRecord, PaymentMethod, PaymentScreenshot, ReviewKind } from './data'
import { db } from './firebase'
import { toE164 } from './firebase-ledger'

export type ReviewDraft = {
  kind: ReviewKind
  proposedAmount: number
  proposedMethod: PaymentMethod
  proposedOccasion: string
  proposedDate: string
  note: string
  proofScreenshots: PaymentScreenshot[]
}

function requireDatabase() {
  if (!db) throw new Error('Firebase is not configured.')
  return db
}

export async function createReviewRequest(entry: LedgerEntry, uid: string, draft: ReviewDraft) {
  if (!entry.createdBy) throw new Error('This entry is missing its owner.')
  const database = requireDatabase()
  const borrowerPhone = toE164(entry.borrower.phone)
  const lenderPhone = toE164(entry.lender.phone)
  const entryRef = doc(database, 'ledgerEntries', entry.id)
  const reviewRef = doc(collection(database, 'ledgerReviews'))
  const review: Omit<LedgerReview, 'createdAt' | 'updatedAt'> & { createdAt: unknown; updatedAt: unknown } = {
    reviewId: reviewRef.id,
    requestedByUid: uid,
    requestedByPhone: borrowerPhone,
    kind: draft.kind,
    proposedAmount: draft.kind === 'amount' ? draft.proposedAmount : 0,
    proposedMethod: draft.proposedMethod,
    proposedOccasion: draft.proposedOccasion.trim().slice(0, 80),
    proposedDate: draft.proposedDate,
    note: draft.note.trim().slice(0, 280),
    proofScreenshots: draft.proofScreenshots,
    status: 'pending',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }

  const batch = writeBatch(database)
  batch.set(reviewRef, {
    entryId: entry.id,
    entryCreatedBy: entry.createdBy,
    lender: { ...entry.lender, phone: lenderPhone },
    borrower: { ...entry.borrower, phone: borrowerPhone },
    lenderPhone,
    borrowerPhone,
    participantPhones: [lenderPhone, borrowerPhone],
    requestedByUid: uid,
    requestedByPhone: borrowerPhone,
    kind: draft.kind,
    originalAmount: entry.amount,
    originalMethod: entry.method,
    originalOccasion: entry.occasion,
    originalDate: entry.date,
    proposedAmount: review.proposedAmount,
    proposedMethod: review.proposedMethod,
    proposedOccasion: review.proposedOccasion,
    proposedDate: review.proposedDate,
    note: review.note,
    proofScreenshots: review.proofScreenshots,
    status: 'pending',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  batch.update(entryRef, {
    review,
    updatedAt: serverTimestamp(),
  })
  await batch.commit()
}

export function subscribeToReviewRecords(
  phone: string,
  onRecords: (records: LedgerReviewRecord[]) => void,
  onError: (error: Error) => void,
) {
  const reviewsQuery = query(
    collection(requireDatabase(), 'ledgerReviews'),
    where('participantPhones', 'array-contains', toE164(phone)),
  )
  return onSnapshot(reviewsQuery, (snapshot) => {
    onRecords(snapshot.docs.map((snapshotDoc) => ({
      id: snapshotDoc.id,
      ...snapshotDoc.data(),
    } as LedgerReviewRecord)))
  }, onError)
}

export async function resolveReviewRequest(
  review: LedgerReview,
  entry: LedgerEntry,
  decision: 'approved' | 'rejected',
  resolvedByUid: string,
) {
  const database = requireDatabase()
  const entryRef = doc(database, 'ledgerEntries', entry.id)
  const updates: Record<string, unknown> = {
    review: deleteField(),
    updatedAt: serverTimestamp(),
  }

  if (decision === 'approved') {
    if (review.kind === 'amount') {
      updates.amount = review.proposedAmount
      if (review.proposedMethod) updates.method = review.proposedMethod
      if (review.proposedOccasion) updates.occasion = review.proposedOccasion
      if (review.proposedDate) updates.date = review.proposedDate
    } else {
      updates.status = 'settled'
      updates.settledAt = new Date().toISOString()
    }
  }

  const splitReference = decision === 'approved' ? getSplitLedgerReference(entry.id) : null
  if (!splitReference) {
    if (!review.reviewId) {
      await updateDoc(entryRef, updates)
      return
    }
    const batch = writeBatch(database)
    batch.update(entryRef, updates)
    batch.update(doc(database, 'ledgerReviews', review.reviewId), {
      status: decision,
      resolvedByUid,
      resolvedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
    await batch.commit()
    return
  }

  const pageRef = doc(database, 'splitPages', splitReference.splitId)
  await runTransaction(database, async (transaction) => {
    const pageSnapshot = await transaction.get(pageRef)
    if (!pageSnapshot.exists()) {
      transaction.update(entryRef, updates)
      if (review.reviewId) {
        transaction.update(doc(database, 'ledgerReviews', review.reviewId), {
          status: decision,
          resolvedByUid,
          resolvedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      }
      return
    }

    const page = pageSnapshot.data() as {
      recipients: Array<{ id: string; amount: number; status: 'pending' | 'paid'; paidAt?: string }>
    }
    const matchingRecipient = page.recipients.find((recipient) => recipient.id === splitReference.recipientId)
    if (!matchingRecipient) throw new Error('Matching split member was not found.')

    if (review.kind === 'amount') {
      transaction.update(pageRef, {
        recipients: page.recipients.map((recipient) => recipient.id === splitReference.recipientId
          ? { ...recipient, amount: review.proposedAmount }
          : recipient),
        totalAmount: page.recipients.reduce((sum, recipient) => (
          sum + (recipient.id === splitReference.recipientId ? review.proposedAmount : recipient.amount)
        ), 0),
        updatedAt: serverTimestamp(),
      })
    } else {
      const paidAt = String(updates.settledAt)
      transaction.update(pageRef, {
        recipients: page.recipients.map((recipient) => recipient.id === splitReference.recipientId
          ? { ...recipient, status: 'paid', paidAt }
          : recipient),
        updatedAt: serverTimestamp(),
      })
    }
    transaction.update(entryRef, updates)
    if (review.reviewId) {
      transaction.update(doc(database, 'ledgerReviews', review.reviewId), {
        status: decision,
        resolvedByUid,
        resolvedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    }
  })
}
