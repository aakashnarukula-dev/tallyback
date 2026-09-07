import {
  collection,
  deleteField,
  doc,
  getDoc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore'
import { LedgerEntry, normalizePhone, Person } from './data'
import { db } from './firebase'
import { toE164 } from './firebase-ledger'

export type SplitRecipient = {
  id: string
  name: string
  amount: number
  status: 'pending' | 'paid'
  paidAt?: string
  ledgerEntryId?: string
}

export type SplitContact = {
  recipientId: string
  name: string
  phone: string
}

export type SplitPage = {
  id: string
  title: string
  description: string
  active: boolean
  currency: 'INR'
  ownerUid: string
  ownerName: string
  recipients: SplitRecipient[]
  totalAmount: number
  createdAt?: unknown
  updatedAt?: unknown
}

export type SplitDraftRecipient = SplitRecipient & { phone: string }

export type SplitDraft = Omit<SplitPage, 'id' | 'ownerUid' | 'ownerName' | 'currency' | 'totalAmount' | 'recipients'> & {
  id?: string
  recipients: SplitDraftRecipient[]
}

function requireDatabase() {
  if (!db) throw new Error('Firebase is not configured.')
  return db
}

export function newRecipient(): SplitDraftRecipient {
  const random = crypto.randomUUID?.().replace(/-/g, '').slice(0, 12) || Math.random().toString(36).slice(2, 14)
  return { id: `member-${random}`, name: '', phone: '', amount: 0, status: 'pending' }
}

export function createSplitId(title: string) {
  const base = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 42) || 'shared-expense'
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${base}-${suffix}`
}

function ledgerId(splitId: string, recipientId: string) {
  return `split-${splitId}-${recipientId}`.slice(0, 180)
}

export function subscribeOwnedSplits(uid: string, onChange: (pages: SplitPage[]) => void, onError: (error: Error) => void) {
  const pagesQuery = query(collection(requireDatabase(), 'splitPages'), where('ownerUid', '==', uid))
  return onSnapshot(pagesQuery, (snapshot) => {
    const pages = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as SplitPage)
    pages.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    onChange(pages)
  }, onError)
}

export function subscribePublicSplit(splitId: string, onChange: (page: SplitPage | null) => void, onError: (error: Error) => void) {
  return onSnapshot(doc(requireDatabase(), 'splitPages', splitId), (snapshot) => {
    onChange(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } as SplitPage : null)
  }, onError)
}

export function subscribeSplitContacts(splitId: string, onChange: (contacts: Record<string, SplitContact>) => void, onError: (error: Error) => void) {
  return onSnapshot(collection(requireDatabase(), 'splitPages', splitId, 'contacts'), (snapshot) => {
    const contacts: Record<string, SplitContact> = {}
    snapshot.forEach((item) => { contacts[item.id] = item.data() as SplitContact })
    onChange(contacts)
  }, onError)
}

export async function saveSplitPage(draft: SplitDraft, uid: string, owner: Person) {
  const title = draft.title.trim().slice(0, 100)
  if (!title) throw new Error('Give this split a title.')
  const recipients = draft.recipients.map((row) => ({
    ...row,
    name: row.name.trim().slice(0, 80),
    phone: normalizePhone(row.phone),
    amount: Number(row.amount),
  }))
  if (!recipients.length) throw new Error('Add at least one person.')
  if (recipients.some((row) => !row.name || row.phone.length !== 10 || !Number.isFinite(row.amount) || row.amount <= 0)) {
    throw new Error('Each person needs a name, a 10-digit number, and an amount.')
  }
  const uniquePhones = new Set(recipients.map((row) => row.phone))
  if (uniquePhones.size !== recipients.length) throw new Error('Each person can appear only once in a split.')
  if (uniquePhones.has(normalizePhone(owner.phone))) throw new Error('You do not need to add yourself to your own split.')

  const database = requireDatabase()
  const splitId = draft.id || createSplitId(title)
  const pageRef = doc(database, 'splitPages', splitId)
  const existingSnapshot = await getDoc(pageRef)
  const existingPage = existingSnapshot.exists() ? existingSnapshot.data() as SplitPage : null
  const existingRecipients = new Map((existingPage?.recipients || []).map((row) => [row.id, row]))
  const nextRecipients: SplitRecipient[] = recipients.map((row) => {
    const existing = existingRecipients.get(row.id)
    return {
      id: row.id,
      name: row.name,
      amount: row.amount,
      status: existing?.status === 'paid' ? 'paid' : 'pending',
      ...(existing?.paidAt ? { paidAt: existing.paidAt } : {}),
      ledgerEntryId: existing?.ledgerEntryId || ledgerId(splitId, row.id),
    }
  })

  const batch = writeBatch(database)
  batch.set(pageRef, {
    title,
    description: draft.description.trim().slice(0, 280),
    active: Boolean(draft.active),
    currency: 'INR',
    ownerUid: uid,
    ownerName: owner.name,
    recipients: nextRecipients,
    totalAmount: nextRecipients.reduce((sum, row) => sum + row.amount, 0),
    updatedAt: serverTimestamp(),
    ...(existingSnapshot.exists() ? {} : { createdAt: serverTimestamp() }),
  }, { merge: true })

  recipients.forEach((row) => {
    const publicRow = nextRecipients.find((candidate) => candidate.id === row.id)!
    batch.set(doc(database, 'splitPages', splitId, 'contacts', row.id), {
      recipientId: row.id,
      name: row.name,
      phone: toE164(row.phone),
      updatedAt: serverTimestamp(),
    })

    const existingRecipient = existingRecipients.get(row.id)
    if (existingRecipient?.status === 'paid') return

    const entryRef = doc(database, 'ledgerEntries', publicRow.ledgerEntryId!)
    const entry: Omit<LedgerEntry, 'id'> & Record<string, unknown> = {
      lender: { name: owner.name, phone: toE164(owner.phone) },
      borrower: { name: row.name, phone: toE164(row.phone) },
      lenderPhone: toE164(owner.phone),
      borrowerPhone: toE164(row.phone),
      participantPhones: [toE164(owner.phone), toE164(row.phone)],
      amount: row.amount,
      occasion: title,
      method: 'Personal funds',
      date: new Date().toISOString().slice(0, 10),
      status: publicRow.status === 'paid' ? 'settled' : 'open',
      createdBy: uid,
      updatedAt: serverTimestamp(),
    }
    if (!existingRecipient) entry.createdAt = serverTimestamp()
    batch.set(entryRef, entry, { merge: Boolean(existingRecipient) })
  })

  for (const oldRecipient of existingPage?.recipients || []) {
    if (nextRecipients.some((row) => row.id === oldRecipient.id)) continue
    batch.delete(doc(database, 'splitPages', splitId, 'contacts', oldRecipient.id))
    if (oldRecipient.ledgerEntryId && oldRecipient.status !== 'paid') {
      batch.update(doc(database, 'ledgerEntries', oldRecipient.ledgerEntryId), {
        status: 'settled',
        settledAt: new Date().toISOString(),
        updatedAt: serverTimestamp(),
      })
    }
  }

  await batch.commit()
  return splitId
}

export async function markSplitRecipientPaid(splitId: string, recipientId: string, uid: string) {
  const database = requireDatabase()
  const pageRef = doc(database, 'splitPages', splitId)
  await runTransaction(database, async (transaction) => {
    const snapshot = await transaction.get(pageRef)
    if (!snapshot.exists()) throw new Error('This split no longer exists.')
    const page = snapshot.data() as SplitPage
    if (page.ownerUid !== uid) throw new Error('Only the split owner can record an offline payment.')
    const recipient = page.recipients.find((row) => row.id === recipientId)
    if (!recipient) throw new Error('This person is no longer in the split.')
    const paidAt = new Date().toISOString()
    transaction.update(pageRef, {
      recipients: page.recipients.map((row) => row.id === recipientId ? { ...row, status: 'paid', paidAt } : row),
      updatedAt: serverTimestamp(),
    })
    if (recipient.ledgerEntryId) {
      transaction.update(doc(database, 'ledgerEntries', recipient.ledgerEntryId), {
        status: 'settled',
        settledAt: paidAt,
        updatedAt: serverTimestamp(),
      })
    }
  })
}

export async function setSplitActive(splitId: string, active: boolean) {
  await updateDoc(doc(requireDatabase(), 'splitPages', splitId), {
    active,
    updatedAt: serverTimestamp(),
    redirectTo: deleteField(),
  })
}
