import {
  collection,
  doc,
  onSnapshot,
  or,
  query,
  runTransaction,
  serverTimestamp,
  deleteField,
  where,
} from 'firebase/firestore'
import {
  LedgerEntry,
  PaymentMethod,
  PaymentScreenshot,
  Person,
  RepaymentRequest,
} from './data'
import { activityDocument } from './firebase-activity'
import { db } from './firebase'
import { getSplitLedgerReference } from './data'
import { applyApprovedPayment, applyRepaymentDecision, entryRemainingAmount, hasValidMoneyPrecision } from './ledger-calculations'

export type RepaymentDraft = {
  amount: number
  method: PaymentMethod
  paidAt: string
  proofScreenshots: PaymentScreenshot[]
  note: string
}

function requireDatabase() {
  if (!db) throw new Error('Firebase is not configured.')
  return db
}

const phoneIdentity = (value: string) => `+91${value.replace(/\D/g, '').slice(-10)}`

export async function createRepaymentRequest(
  entry: LedgerEntry,
  borrowerId: string,
  borrower: Person,
  draft: RepaymentDraft,
) {
  if (!entry.createdBy) throw new Error('This due is missing its lender identity.')
  if (phoneIdentity(borrower.phone) !== phoneIdentity(entry.borrower.phone)) {
    throw new Error('Only borrower can record this payment.')
  }
  if (!Number.isFinite(draft.amount) || draft.amount <= 0) {
    throw new Error('Payment amount must be greater than zero.')
  }
  if (!hasValidMoneyPrecision(draft.amount)) {
    throw new Error('Payment amount can have at most two decimal places.')
  }
  if (!draft.proofScreenshots.length) throw new Error('Add at least one payment-proof screenshot.')
  if (draft.proofScreenshots.length > 5) throw new Error('Add no more than five payment-proof screenshots.')

  const database = requireDatabase()
  const requestRef = doc(collection(database, 'repaymentRequests'))
  const entryRef = doc(database, 'ledgerEntries', entry.id)

  await runTransaction(database, async (transaction) => {
    const entrySnapshot = await transaction.get(entryRef)
    if (!entrySnapshot.exists()) throw new Error('This due no longer exists.')
    const liveEntry = { id: entrySnapshot.id, ...entrySnapshot.data() } as LedgerEntry
    if (liveEntry.pendingRepaymentId) {
      throw new Error('This due already has a payment waiting for review.')
    }
    if (draft.amount > entryRemainingAmount(liveEntry)) {
      throw new Error('Payment amount cannot exceed remaining due.')
    }

    const lenderPhone = phoneIdentity(liveEntry.lender.phone)
    const borrowerPhone = phoneIdentity(liveEntry.borrower.phone)
    const activity = activityDocument(
      liveEntry,
      borrowerId,
      borrower,
      'repayment_submitted',
      requestRef.id,
      {
        amount: draft.amount,
        eventDate: draft.paidAt,
        method: draft.method,
        note: draft.note,
        status: 'pending',
      },
    )
    transaction.set(requestRef, {
      dueId: liveEntry.id,
      lenderId: liveEntry.createdBy,
      lenderPhone,
      borrowerId,
      borrowerPhone,
      participantPhones: [lenderPhone, borrowerPhone],
      payerName: borrower.name.trim().slice(0, 120),
      amount: draft.amount,
      method: draft.method,
      paidAt: draft.paidAt,
      proofScreenshots: draft.proofScreenshots,
      note: draft.note.trim().slice(0, 280),
      status: 'pending',
      createdAt: serverTimestamp(),
    })
    transaction.update(entryRef, {
      pendingRepaymentId: requestRef.id,
      historyStarted: true,
      updatedAt: serverTimestamp(),
    })
    transaction.set(activity.ref, activity.data)
  })

  return requestRef.id
}

export function subscribeToRepaymentRequests(
  phone: string,
  onRecords: (records: RepaymentRequest[]) => void,
  onError: (error: Error) => void,
) {
  const requestsQuery = query(
    collection(requireDatabase(), 'repaymentRequests'),
    or(
      where('lenderPhone', '==', phoneIdentity(phone)),
      where('borrowerPhone', '==', phoneIdentity(phone)),
    ),
  )
  return onSnapshot(requestsQuery, (snapshot) => {
    onRecords(snapshot.docs.map((snapshotDoc) => ({
      id: snapshotDoc.id,
      ...snapshotDoc.data(),
    } as RepaymentRequest)))
  }, onError)
}

export async function resolveRepaymentRequest(
  request: RepaymentRequest,
  decision: 'accepted' | 'rejected',
  lenderId: string,
  lender: Person,
) {
  const database = requireDatabase()
  const requestRef = doc(database, 'repaymentRequests', request.id)
  const entryRef = doc(database, 'ledgerEntries', request.dueId)
  const resolutionActivityRef = doc(collection(database, 'ledgerActivities'))
  const paidActivityRef = doc(collection(database, 'ledgerActivities'))

  await runTransaction(database, async (transaction) => {
    const [requestSnapshot, entrySnapshot] = await Promise.all([
      transaction.get(requestRef),
      transaction.get(entryRef),
    ])
    if (!requestSnapshot.exists()) throw new Error('Payment request no longer exists.')
    if (!entrySnapshot.exists()) throw new Error('Due no longer exists.')

    const liveRequest = { id: requestSnapshot.id, ...requestSnapshot.data() } as RepaymentRequest
    const liveEntry = { id: entrySnapshot.id, ...entrySnapshot.data() } as LedgerEntry
    if (liveRequest.status !== 'pending') throw new Error('Payment request was already reviewed.')
    if (liveRequest.lenderId !== lenderId || phoneIdentity(lender.phone) !== liveRequest.lenderPhone) {
      throw new Error('Only lender can review this payment.')
    }
    if (liveEntry.pendingRepaymentId && liveEntry.pendingRepaymentId !== liveRequest.id) {
      throw new Error('A newer payment request is waiting for review. Refresh and retry.')
    }

    const splitReference = decision === 'accepted' ? getSplitLedgerReference(liveEntry.id) : null
    const nextBalance = decision === 'accepted'
      ? applyRepaymentDecision(liveEntry, liveRequest.amount, decision)
      : null
    const pageRef = splitReference ? doc(database, 'splitPages', splitReference.splitId) : null
    const pageSnapshot = pageRef && nextBalance?.status === 'paid'
      ? await transaction.get(pageRef)
      : null

    transaction.update(requestRef, {
      status: decision,
      reviewedAt: serverTimestamp(),
      reviewedBy: lenderId,
    })

    const resolutionActivity = activityDocument(
      liveEntry,
      lenderId,
      lender,
      decision === 'accepted' ? 'repayment_accepted' : 'repayment_rejected',
      liveRequest.id,
      {
        amount: liveRequest.amount,
        eventDate: liveRequest.paidAt,
        method: liveRequest.method,
        note: liveRequest.note,
        status: decision,
      },
    )
    transaction.set(resolutionActivityRef, resolutionActivity.data)

    if (!nextBalance) {
      transaction.update(entryRef, {
        ...(liveEntry.pendingRepaymentId === liveRequest.id ? { pendingRepaymentId: deleteField() } : {}),
        historyStarted: true,
        updatedAt: serverTimestamp(),
      })
      return
    }

    transaction.update(entryRef, {
      ...nextBalance,
      lastRepaymentId: liveRequest.id,
      ...(liveEntry.pendingRepaymentId === liveRequest.id ? { pendingRepaymentId: deleteField() } : {}),
      historyStarted: true,
      ...(nextBalance.status === 'paid' ? { settledAt: new Date().toISOString() } : {}),
      updatedAt: serverTimestamp(),
    })

    if (nextBalance.status === 'paid') {
      const paidActivity = activityDocument(
        { ...liveEntry, ...nextBalance },
        lenderId,
        lender,
        'due_marked_paid',
        liveRequest.id,
        {
          amount: liveRequest.amount,
          eventDate: liveRequest.paidAt,
          method: liveRequest.method,
          note: liveRequest.note,
          status: 'paid',
        },
      )
      transaction.set(paidActivityRef, paidActivity.data)

      if (pageRef && pageSnapshot?.exists() && splitReference) {
        const page = pageSnapshot.data() as {
          recipients: Array<{ id: string; status: 'pending' | 'paid'; paidAt?: string }>
        }
        transaction.update(pageRef, {
          recipients: page.recipients.map((recipient) => recipient.id === splitReference.recipientId
            ? { ...recipient, status: 'paid', paidAt: new Date().toISOString() }
            : recipient),
          updatedAt: serverTimestamp(),
        })
      }
    }
  })
}

export async function recordLenderPayment(
  entry: LedgerEntry,
  lenderId: string,
  lender: Person,
  draft: RepaymentDraft,
) {
  if (!entry.createdBy) throw new Error('This due is missing its lender identity.')
  if (entry.createdBy !== lenderId || phoneIdentity(lender.phone) !== phoneIdentity(entry.lender.phone)) {
    throw new Error('Only lender can record payment on this due.')
  }
  if (!Number.isFinite(draft.amount) || draft.amount <= 0) {
    throw new Error('Payment amount must be greater than zero.')
  }
  if (!hasValidMoneyPrecision(draft.amount)) {
    throw new Error('Payment amount can have at most two decimal places.')
  }
  if (draft.proofScreenshots.length > 5) throw new Error('Add no more than five payment-proof screenshots.')

  const database = requireDatabase()
  const requestRef = doc(collection(database, 'repaymentRequests'))
  const entryRef = doc(database, 'ledgerEntries', entry.id)
  const acceptedActivityRef = doc(collection(database, 'ledgerActivities'))
  const paidActivityRef = doc(collection(database, 'ledgerActivities'))

  await runTransaction(database, async (transaction) => {
    const entrySnapshot = await transaction.get(entryRef)
    if (!entrySnapshot.exists()) throw new Error('This due no longer exists.')

    const liveEntry = { id: entrySnapshot.id, ...entrySnapshot.data() } as LedgerEntry
    if (liveEntry.createdBy !== lenderId || phoneIdentity(lender.phone) !== phoneIdentity(liveEntry.lender.phone)) {
      throw new Error('Only lender can record payment on this due.')
    }
    if (liveEntry.pendingRepaymentId) {
      throw new Error('Review the pending payment before recording another one.')
    }
    const nextBalance = applyApprovedPayment(liveEntry, draft.amount)
    const splitReference = nextBalance.status === 'paid' ? getSplitLedgerReference(liveEntry.id) : null
    const pageRef = splitReference ? doc(database, 'splitPages', splitReference.splitId) : null
    const pageSnapshot = pageRef ? await transaction.get(pageRef) : null
    const recordedAt = new Date().toISOString()

    const lenderPhone = phoneIdentity(liveEntry.lender.phone)
    const borrowerPhone = phoneIdentity(liveEntry.borrower.phone)
    transaction.set(requestRef, {
      dueId: liveEntry.id,
      lenderId,
      lenderPhone,
      borrowerPhone,
      participantPhones: [lenderPhone, borrowerPhone],
      payerName: liveEntry.borrower.name.trim().slice(0, 120),
      amount: draft.amount,
      method: draft.method,
      paidAt: draft.paidAt,
      proofScreenshots: draft.proofScreenshots,
      note: draft.note.trim().slice(0, 280),
      status: 'accepted',
      recordedBy: 'lender',
      createdAt: serverTimestamp(),
      reviewedAt: serverTimestamp(),
      reviewedBy: lenderId,
    })
    transaction.update(entryRef, {
      ...nextBalance,
      lastRepaymentId: requestRef.id,
      historyStarted: true,
      ...(nextBalance.status === 'paid' ? { settledAt: recordedAt } : {}),
      updatedAt: serverTimestamp(),
    })

    const acceptedActivity = activityDocument(
      { ...liveEntry, ...nextBalance },
      lenderId,
      lender,
      'payment_recorded',
      requestRef.id,
      {
        amount: draft.amount,
        eventDate: draft.paidAt,
        method: draft.method,
        note: draft.note,
        status: 'accepted',
      },
    )
    transaction.set(acceptedActivityRef, acceptedActivity.data)

    if (nextBalance.status !== 'paid') return

    const paidActivity = activityDocument(
      { ...liveEntry, ...nextBalance },
      lenderId,
      lender,
      'due_marked_paid',
      requestRef.id,
      {
        amount: draft.amount,
        eventDate: draft.paidAt,
        method: draft.method,
        note: draft.note,
        status: 'paid',
      },
    )
    transaction.set(paidActivityRef, paidActivity.data)

    if (pageRef && pageSnapshot?.exists() && splitReference) {
      const page = pageSnapshot.data() as {
        ownerUid: string
        recipients: Array<{ id: string; status: 'pending' | 'paid'; paidAt?: string }>
      }
      if (page.ownerUid !== lenderId) throw new Error('Only split owner can record this payment.')
      transaction.update(pageRef, {
        recipients: page.recipients.map((recipient) => recipient.id === splitReference.recipientId
          ? { ...recipient, status: 'paid', paidAt: recordedAt }
          : recipient),
        updatedAt: serverTimestamp(),
      })
    }
  })

  return requestRef.id
}
