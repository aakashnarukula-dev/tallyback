import {
  collection,
  deleteField,
  doc,
  onSnapshot,
  or,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from 'firebase/firestore'
import { activityDocument } from './firebase-activity'
import { getSplitLedgerReference, LedgerEntry, LedgerReview, LedgerReviewRecord, PaymentMethod, PaymentScreenshot, ReviewKind } from './data'
import { db } from './firebase'
import { toE164 } from './firebase-ledger'
import { entryOriginalAmount, entryPaidAmount, entryRemainingAmount } from './ledger-calculations'

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

  const paidAmount = entryPaidAmount(entry)
  if (draft.kind === 'amount' && draft.proposedAmount < paidAmount) {
    throw new Error('Corrected amount cannot be less than approved payments.')
  }
  const reviewRecord = {
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
    originalAmount: entryOriginalAmount(entry),
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
  }
  const activity = activityDocument(
    entry,
    uid,
    entry.borrower,
    draft.kind === 'paid' ? 'repayment_submitted' : 'mistake_reported',
    reviewRef.id,
    {
      amount: draft.kind === 'paid' ? entryRemainingAmount(entry) : draft.proposedAmount,
      eventDate: draft.proposedDate,
      method: draft.proposedMethod,
      note: draft.note,
      status: 'pending',
    },
  )

  await runTransaction(database, async (transaction) => {
    const entrySnapshot = await transaction.get(entryRef)
    if (!entrySnapshot.exists()) throw new Error('This due no longer exists.')
    const liveEntry = { id: entrySnapshot.id, ...entrySnapshot.data() } as LedgerEntry
    if (liveEntry.review?.status === 'pending') throw new Error('This due already has a pending review.')
    if (liveEntry.pendingRepaymentId) throw new Error('Wait for the pending payment to be reviewed first.')
    transaction.set(reviewRef, reviewRecord)
    transaction.update(entryRef, { review, historyStarted: true, updatedAt: serverTimestamp() })
    transaction.set(activity.ref, activity.data)
  })
}

export function subscribeToReviewRecords(
  phone: string,
  onRecords: (records: LedgerReviewRecord[]) => void,
  onError: (error: Error) => void,
) {
  const reviewsQuery = query(
    collection(requireDatabase(), 'ledgerReviews'),
    or(
      where('lenderPhone', '==', toE164(phone)),
      where('borrowerPhone', '==', toE164(phone)),
    ),
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
  const reviewRef = review.reviewId ? doc(database, 'ledgerReviews', review.reviewId) : null
  const resolutionActivityRef = doc(collection(database, 'ledgerActivities'))
  const paidActivityRef = doc(collection(database, 'ledgerActivities'))
  await runTransaction(database, async (transaction) => {
    const [entrySnapshot, reviewSnapshot] = await Promise.all([
      transaction.get(entryRef),
      reviewRef ? transaction.get(reviewRef) : Promise.resolve(null),
    ])
    if (!entrySnapshot.exists()) throw new Error('This due no longer exists.')
    const liveEntry = { id: entrySnapshot.id, ...entrySnapshot.data() } as LedgerEntry
    const liveReview = liveEntry.review
    if (!liveReview || liveReview.reviewId !== review.reviewId || liveReview.status !== 'pending') {
      throw new Error('Review request was already resolved.')
    }
    if (reviewSnapshot && (!reviewSnapshot.exists() || reviewSnapshot.data().status !== 'pending')) {
      throw new Error('Review request was already resolved.')
    }
    if (liveEntry.createdBy !== resolvedByUid) throw new Error('Only lender can resolve this review.')

    const paidAmount = entryPaidAmount(liveEntry)
    const updates: Record<string, unknown> = {
      review: deleteField(),
      historyStarted: true,
      updatedAt: serverTimestamp(),
    }
    if (decision === 'approved' && liveReview.kind === 'amount') {
      if (liveReview.proposedAmount < paidAmount) {
        throw new Error('Corrected amount cannot be less than approved payments.')
      }
      const remainingAmount = Math.max(0, liveReview.proposedAmount - paidAmount)
      updates.amount = liveReview.proposedAmount
      updates.originalAmount = liveReview.proposedAmount
      updates.paidAmount = paidAmount
      updates.remainingAmount = remainingAmount
      updates.status = remainingAmount === 0 ? 'paid' : paidAmount > 0 ? 'partially_paid' : 'open'
      if (remainingAmount === 0) updates.settledAt = new Date().toISOString()
      if (liveReview.proposedMethod) updates.method = liveReview.proposedMethod
      if (liveReview.proposedOccasion) updates.occasion = liveReview.proposedOccasion
      if (liveReview.proposedDate) updates.date = liveReview.proposedDate
    } else if (decision === 'approved') {
      const originalAmount = entryOriginalAmount(liveEntry)
      updates.originalAmount = originalAmount
      updates.paidAmount = originalAmount
      updates.remainingAmount = 0
      updates.status = 'paid'
      updates.settledAt = new Date().toISOString()
    }

    const splitReference = decision === 'approved' ? getSplitLedgerReference(liveEntry.id) : null
    const pageRef = splitReference ? doc(database, 'splitPages', splitReference.splitId) : null
    const pageSnapshot = pageRef ? await transaction.get(pageRef) : null
    if (pageSnapshot?.exists() && pageRef && splitReference) {
      const page = pageSnapshot.data() as {
      recipients: Array<{ id: string; amount: number; status: 'pending' | 'paid'; paidAt?: string }>
      }
      const matchingRecipient = page.recipients.find((recipient) => recipient.id === splitReference.recipientId)
      if (!matchingRecipient) throw new Error('Matching split member was not found.')

      if (liveReview.kind === 'amount') {
        const correctedRemaining = Math.max(0, liveReview.proposedAmount - paidAmount)
        transaction.update(pageRef, {
          recipients: page.recipients.map((recipient) => recipient.id === splitReference.recipientId
            ? {
                ...recipient,
                amount: liveReview.proposedAmount,
                ...(correctedRemaining === 0 ? { status: 'paid', paidAt: String(updates.settledAt) } : {}),
              }
            : recipient),
          totalAmount: page.recipients.reduce((sum, recipient) => (
            sum + (recipient.id === splitReference.recipientId ? liveReview.proposedAmount : recipient.amount)
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
    }

    transaction.update(entryRef, updates)
    if (reviewRef) {
      transaction.update(reviewRef, {
        status: decision,
        resolvedByUid,
        resolvedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    }

    const activityType = liveReview.kind === 'amount'
      ? decision === 'approved' ? 'correction_accepted' : 'correction_rejected'
      : decision === 'approved' ? 'repayment_accepted' : 'repayment_rejected'
    const resolutionActivity = activityDocument(
      liveEntry,
      resolvedByUid,
      liveEntry.lender,
      activityType,
      liveReview.reviewId ?? liveEntry.id,
      {
        amount: liveReview.kind === 'amount' ? liveReview.proposedAmount : entryRemainingAmount(liveEntry),
        eventDate: liveReview.proposedDate ?? liveEntry.date,
        method: liveReview.proposedMethod ?? liveEntry.method,
        note: liveReview.note,
        status: decision === 'approved' ? 'accepted' : 'rejected',
      },
    )
    transaction.set(resolutionActivityRef, resolutionActivity.data)

    const dueBecamePaid = decision === 'approved' && (
      liveReview.kind === 'paid'
      || (liveReview.kind === 'amount' && liveReview.proposedAmount === paidAmount)
    )
    if (dueBecamePaid) {
      const paidActivity = activityDocument(
        { ...liveEntry, status: 'paid', remainingAmount: 0, paidAmount: entryOriginalAmount(liveEntry) },
        resolvedByUid,
        liveEntry.lender,
        'due_marked_paid',
        liveReview.reviewId ?? liveEntry.id,
        {
          amount: liveReview.kind === 'amount' ? liveReview.proposedAmount : entryRemainingAmount(liveEntry),
          eventDate: liveReview.proposedDate ?? liveEntry.date,
          method: liveReview.proposedMethod ?? liveEntry.method,
          note: liveReview.note,
          status: 'paid',
        },
      )
      transaction.set(paidActivityRef, paidActivity.data)
    }
  })
}
