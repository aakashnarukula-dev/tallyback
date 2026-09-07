import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  or,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore'
import { LedgerEntry, Person } from './data'
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
  })
}

export async function settleEntry(entryId: string) {
  await updateDoc(doc(requireDatabase(), 'ledgerEntries', entryId), {
    status: 'settled',
    settledAt: new Date().toISOString(),
    updatedAt: serverTimestamp(),
  })
}
