import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  or,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore'
import { getSplitLedgerReference, LedgerEntry, Person } from './data'
import { db } from './firebase'

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
  const lenderPhone = toE164(entry.lender.phone)
  const borrowerPhone = toE164(entry.borrower.phone)

  await setDoc(doc(requireDatabase(), 'ledgerEntries', entry.id), {
    lender: { ...entry.lender, phone: lenderPhone },
    borrower: { ...entry.borrower, phone: borrowerPhone },
    lenderPhone,
    borrowerPhone,
    participantPhones: [lenderPhone, borrowerPhone],
    amount: entry.amount,
    occasion: entry.occasion,
    method: entry.method,
    date: entry.date,
    status: 'open',
    createdBy: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...(entry.screenshots?.length ? { screenshots: entry.screenshots } : {}),
  })
}

export async function settleEntry(entryId: string, uid: string) {
  const database = requireDatabase()
  const entryRef = doc(database, 'ledgerEntries', entryId)
  const splitReference = getSplitLedgerReference(entryId)
  const settledAt = new Date().toISOString()

  if (!splitReference) {
    await updateDoc(entryRef, {
      status: 'settled',
      settledAt,
      updatedAt: serverTimestamp(),
    })
    return
  }

  const pageRef = doc(database, 'splitPages', splitReference.splitId)
  await runTransaction(database, async (transaction) => {
    const pageSnapshot = await transaction.get(pageRef)
    if (!pageSnapshot.exists()) {
      transaction.update(entryRef, { status: 'settled', settledAt, updatedAt: serverTimestamp() })
      return
    }

    const page = pageSnapshot.data() as {
      ownerUid: string
      recipients: Array<{ id: string; status: 'pending' | 'paid'; paidAt?: string }>
    }
    if (page.ownerUid !== uid) throw new Error('Only the split owner can mark this due paid.')
    if (!page.recipients.some((recipient) => recipient.id === splitReference.recipientId)) {
      throw new Error('Matching split member was not found.')
    }

    transaction.update(pageRef, {
      recipients: page.recipients.map((recipient) => recipient.id === splitReference.recipientId
        ? { ...recipient, status: 'paid', paidAt: settledAt }
        : recipient),
      updatedAt: serverTimestamp(),
    })
    transaction.update(entryRef, { status: 'settled', settledAt, updatedAt: serverTimestamp() })
  })
}

export async function deleteEntry(entryId: string) {
  await deleteDoc(doc(requireDatabase(), 'ledgerEntries', entryId))
}
