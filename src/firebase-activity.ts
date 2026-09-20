import {
  collection,
  doc,
  onSnapshot,
  or,
  query,
  serverTimestamp,
  where,
} from 'firebase/firestore'
import {
  LedgerActivity,
  LedgerActivityType,
  LedgerEntry,
  PaymentMethod,
  Person,
} from './data'
import { db } from './firebase'
import { canonicalEntryStatus, entryOriginalAmount } from './ledger-calculations'

function requireDatabase() {
  if (!db) throw new Error('Firebase is not configured.')
  return db
}

const phoneIdentity = (value: string) => `+91${value.replace(/\D/g, '').slice(-10)}`

export type ActivityDetails = {
  amount?: number
  eventDate?: string
  method?: PaymentMethod
  note?: string
  status?: LedgerActivity['status']
}

export function activityDocument(
  entry: LedgerEntry,
  actorUid: string,
  actor: Person,
  type: LedgerActivityType,
  sourceId: string,
  details: ActivityDetails = {},
) {
  const database = requireDatabase()
  const lenderPhone = phoneIdentity(entry.lender.phone)
  const borrowerPhone = phoneIdentity(entry.borrower.phone)
  return {
    ref: doc(collection(database, 'ledgerActivities')),
    data: {
      dueId: entry.id,
      sourceId,
      type,
      actorUid,
      actorPhone: phoneIdentity(actor.phone),
      actorName: actor.name.trim().slice(0, 120),
      lender: { name: entry.lender.name, phone: lenderPhone },
      borrower: { name: entry.borrower.name, phone: borrowerPhone },
      lenderPhone,
      borrowerPhone,
      participantPhones: [lenderPhone, borrowerPhone],
      amount: details.amount ?? entryOriginalAmount(entry),
      eventDate: details.eventDate ?? entry.date,
      method: details.method ?? entry.method,
      note: (details.note ?? '').trim().slice(0, 280),
      status: details.status ?? canonicalEntryStatus(entry),
      occurredAt: serverTimestamp(),
    },
  }
}

export function subscribeToActivities(
  phone: string,
  onRecords: (records: LedgerActivity[]) => void,
  onError: (error: Error) => void,
) {
  const activitiesQuery = query(
    collection(requireDatabase(), 'ledgerActivities'),
    or(
      where('lenderPhone', '==', phoneIdentity(phone)),
      where('borrowerPhone', '==', phoneIdentity(phone)),
    ),
  )

  return onSnapshot(activitiesQuery, (snapshot) => {
    onRecords(snapshot.docs.map((snapshotDoc) => ({
      id: snapshotDoc.id,
      ...snapshotDoc.data(),
    } as LedgerActivity)))
  }, onError)
}
