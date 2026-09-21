import {
  collection,
  deleteField,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  or,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  writeBatch,
  where,
} from 'firebase/firestore'
import { activityDocument } from './firebase-activity'
import { getSplitLedgerReference, LedgerEntry, Person } from './data'
import { db } from './firebase'
import { entryOriginalAmount, entryPaidAmount } from './ledger-calculations'
import { MAX_PAYMENT_SCREENSHOTS } from './firebase-storage'

export const toE164 = (phone: string) => {
  const digits = phone.replace(/\D/g, '').slice(-10)
  return `+91${digits}`
}

function requireDatabase() {
  if (!db) throw new Error('Firebase is not configured.')
  return db
}

export async function getUserProfile(uid: string): Promise<Person | null> {
  const snapshot = await getDoc(doc(requireDatabase(), 'users', uid))
  if (!snapshot.exists()) return null
  const data = snapshot.data()
  return { name: data.name, phone: data.phone }
}

export async function saveUserProfile(uid: string, person: Person) {
  await setDoc(
    doc(requireDatabase(), 'users', uid),
    {
      name: person.name,
      phone: toE164(person.phone),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )
}

export function subscribeToEntries(
  phone: string,
  onEntries: (entries: LedgerEntry[]) => void,
  onError: (error: Error) => void,
) {
  const entriesQuery = query(
    collection(requireDatabase(), 'ledgerEntries'),
    or(
      where('lenderPhone', '==', toE164(phone)),
      where('borrowerPhone', '==', toE164(phone)),
    ),
  )

  return onSnapshot(
    entriesQuery,
    (snapshot) => {
      onEntries(snapshot.docs.map((entryDoc) => ({
        ...(entryDoc.data() as Omit<LedgerEntry, 'id'>),
        id: entryDoc.id,
      })))
    },
    (error) => onError(error),
  )
}

export async function createEntry(entry: LedgerEntry, uid: string) {
  if ((entry.screenshots?.length ?? 0) > MAX_PAYMENT_SCREENSHOTS) throw new Error('Attach only one receiver screenshot.')
  const database = requireDatabase()
  const lenderPhone = toE164(entry.lender.phone)
  const borrowerPhone = toE164(entry.borrower.phone)
  const canonicalEntry: LedgerEntry = {
    ...entry,
    lender: { name: entry.lender.name, phone: lenderPhone },
    borrower: { name: entry.borrower.name, phone: borrowerPhone },
    amount: entry.amount,
    originalAmount: entry.amount,
    paidAmount: 0,
    remainingAmount: entry.amount,
    status: 'open',
    historyStarted: false,
    createdBy: uid,
  }
  const batch = writeBatch(database)
  batch.set(doc(database, 'ledgerEntries', entry.id), {
    // Ledger participants are a public Firestore contract. Saved contacts also
    // carry local-only metadata such as `source`, which the security rules
    // intentionally reject. Whitelist the persisted fields at this boundary.
    lender: { name: entry.lender.name, phone: lenderPhone },
    borrower: { name: entry.borrower.name, phone: borrowerPhone },
    lenderPhone,
    borrowerPhone,
    participantPhones: [lenderPhone, borrowerPhone],
    amount: entry.amount,
    originalAmount: entry.amount,
    paidAmount: 0,
    remainingAmount: entry.amount,
    occasion: entry.occasion,
    method: entry.method,
    date: entry.date,
    status: 'open',
    historyStarted: false,
    createdBy: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...(entry.screenshots?.length ? { screenshots: entry.screenshots } : {}),
  })
  const activity = activityDocument(canonicalEntry, uid, canonicalEntry.lender, 'due_created', entry.id, {
    amount: entry.amount,
    status: 'open',
  })
  batch.set(activity.ref, activity.data)
  await batch.commit()
}

export async function updateEntry(entry: LedgerEntry, uid: string, actor: Person) {
  const database = requireDatabase()
  const paidAmount = entryPaidAmount(entry)
  if (entry.amount < paidAmount) throw new Error('Due amount cannot be less than approved payments.')
  const remainingAmount = Math.max(0, entry.amount - paidAmount)
  const status = remainingAmount === 0 ? 'paid' : paidAmount > 0 ? 'partially_paid' : 'open'
  const batch = writeBatch(database)
  batch.update(doc(database, 'ledgerEntries', entry.id), {
    amount: entry.amount,
    originalAmount: entry.amount,
    paidAmount,
    remainingAmount,
    status,
    occasion: entry.occasion,
    method: entry.method,
    date: entry.date,
    screenshots: entry.screenshots?.length ? entry.screenshots : deleteField(),
    updatedAt: serverTimestamp(),
  })
  const activity = activityDocument(
    { ...entry, originalAmount: entry.amount, paidAmount, remainingAmount, status },
    uid,
    actor,
    'due_edited',
    entry.id,
    { amount: entry.amount, status },
  )
  batch.set(activity.ref, activity.data)
  await batch.commit()
}

export async function settleEntry(entryId: string, uid: string) {
  const database = requireDatabase()
  const entryRef = doc(database, 'ledgerEntries', entryId)
  const splitReference = getSplitLedgerReference(entryId)
  const settledAt = new Date().toISOString()
  await runTransaction(database, async (transaction) => {
    const entrySnapshot = await transaction.get(entryRef)
    if (!entrySnapshot.exists()) throw new Error('This due no longer exists.')
    const entry = { id: entrySnapshot.id, ...entrySnapshot.data() } as LedgerEntry
    const originalAmount = entryOriginalAmount(entry)
    const paidAmount = entryPaidAmount(entry)
    const remainingAmount = Math.max(0, originalAmount - paidAmount)
    if (remainingAmount <= 0) throw new Error('This due is already paid.')

    const pageRef = splitReference ? doc(database, 'splitPages', splitReference.splitId) : null
    const pageSnapshot = pageRef ? await transaction.get(pageRef) : null
    if (pageRef && pageSnapshot?.exists()) {
      const page = pageSnapshot.data() as {
        ownerUid: string
        recipients: Array<{ id: string; status: 'pending' | 'paid'; paidAt?: string }>
      }
      if (page.ownerUid !== uid) throw new Error('Only the split owner can mark this due paid.')
      if (!page.recipients.some((recipient) => recipient.id === splitReference?.recipientId)) {
        throw new Error('Matching split member was not found.')
      }

      transaction.update(pageRef, {
        recipients: page.recipients.map((recipient) => recipient.id === splitReference?.recipientId
          ? { ...recipient, status: 'paid', paidAt: settledAt }
          : recipient),
        updatedAt: serverTimestamp(),
      })
    }

    transaction.update(entryRef, {
      originalAmount,
      paidAmount: originalAmount,
      remainingAmount: 0,
      status: 'paid',
      settledAt,
      updatedAt: serverTimestamp(),
    })
    const activity = activityDocument(
      { ...entry, originalAmount, paidAmount: originalAmount, remainingAmount: 0, status: 'paid' },
      uid,
      entry.lender,
      'due_marked_paid',
      entry.id,
      { amount: remainingAmount, status: 'paid' },
    )
    transaction.set(activity.ref, activity.data)
  })
}

export async function syncParticipantName(entries: LedgerEntry[], uid: string, phone: string, name: string) {
  const database = requireDatabase()
  const canonicalPhone = toE164(phone)
  const matchingEntries = entries.filter((entry) => (
    toE164(entry.lender.phone) === canonicalPhone || toE164(entry.borrower.phone) === canonicalPhone
  ))

  for (let index = 0; index < matchingEntries.length; index += 450) {
    const batch = writeBatch(database)
    matchingEntries.slice(index, index + 450).forEach((entry) => {
      const field = toE164(entry.lender.phone) === canonicalPhone ? 'lender.name' : 'borrower.name'
      batch.update(doc(database, 'ledgerEntries', entry.id), {
        [field]: name,
        updatedAt: serverTimestamp(),
      })
    })
    await batch.commit()
  }
}

export async function deleteEntry(entryId: string) {
  await deleteDoc(doc(requireDatabase(), 'ledgerEntries', entryId))
}
