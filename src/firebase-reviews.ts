import {
  deleteField,
  doc,
  runTransaction,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore'
import { getSplitLedgerReference, LedgerEntry, LedgerReview, ReviewKind } from './data'
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
  const entryRef = doc(database, 'ledgerEntries', entry.id)
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

  const splitReference = decision === 'approved' ? getSplitLedgerReference(entry.id) : null
  if (!splitReference) {
    await updateDoc(entryRef, updates)
    return
  }

  const pageRef = doc(database, 'splitPages', splitReference.splitId)
  await runTransaction(database, async (transaction) => {
    const pageSnapshot = await transaction.get(pageRef)
    if (!pageSnapshot.exists()) {
      transaction.update(entryRef, updates)
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
  })
}
