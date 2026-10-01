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
import { activityDocument } from './firebase-activity'
import { LedgerEntry, normalizePhone, Person } from './data'
import { db } from './firebase'
import { getUpiId, toE164 } from './firebase-ledger'
import { entryOriginalAmount, entryPaidAmount } from './ledger-calculations'

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
  ownerUpiId?: string
  recipients: SplitRecipient[]
  totalAmount: number
  createdAt?: unknown
  updatedAt?: unknown
}

export type SplitDraftRecipient = SplitRecipient & { phone: string }

export type SplitDraft = Omit<SplitPage, 'id' | 'ownerUid' | 'ownerName' | 'ownerUpiId' | 'currency' | 'totalAmount' | 'recipients'> & {
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
  // A number is optional: a member added by name only has no due until their
  // number is filled in.
  if (recipients.some((row) => !row.name || (row.phone && row.phone.length !== 10) || !Number.isFinite(row.amount) || row.amount <= 0)) {
    throw new Error('Each person needs a name, an amount, and a 10-digit number if you add one.')
  }
  const phones = recipients.map((row) => row.phone).filter(Boolean)
  if (new Set(phones).size !== phones.length) throw new Error('Each person can appear only once in a split.')
  // A split is the whole group's cost, so the owner is listed with their own
  // share. That share is already paid (they paid the bill) and is never a due.
  const ownerPhone = normalizePhone(owner.phone)
  const isOwnerRow = (row: { phone: string }) => Boolean(row.phone) && row.phone === ownerPhone

  const database = requireDatabase()
  const splitId = draft.id || createSplitId(title)
  const pageRef = doc(database, 'splitPages', splitId)
  const [existingSnapshot, ownerUpiId] = await Promise.all([getDoc(pageRef), getUpiId(owner.phone)])
  const existingPage = existingSnapshot.exists() ? existingSnapshot.data() as SplitPage : null
  const existingRecipients = new Map((existingPage?.recipients || []).map((row) => [row.id, row]))
  const nextRecipients: SplitRecipient[] = recipients.map((row) => {
    const existing = existingRecipients.get(row.id)
    if (isOwnerRow(row)) {
      return {
        id: row.id,
        name: row.name,
        amount: row.amount,
        status: 'paid',
        paidAt: existing?.paidAt || new Date().toISOString(),
      }
    }
    return {
      id: row.id,
      name: row.name,
      amount: row.amount,
      status: existing?.status === 'paid' ? 'paid' : 'pending',
      ...(existing?.paidAt ? { paidAt: existing.paidAt } : {}),
      ledgerEntryId: existing?.ledgerEntryId || ledgerId(splitId, row.id),
    }
  })

  const ledgerEntryIds = new Set([
    ...nextRecipients.map((row) => row.ledgerEntryId).filter(Boolean),
    ...(existingPage?.recipients ?? []).map((row) => row.ledgerEntryId).filter(Boolean),
  ] as string[])
  const ledgerSnapshots = await Promise.all([...ledgerEntryIds].map(async (entryId) => {
    const snapshot = await getDoc(doc(database, 'ledgerEntries', entryId))
    return [entryId, snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } as LedgerEntry : null] as const
  }))
  const existingLedgerEntries = new Map(ledgerSnapshots)

  const batch = writeBatch(database)
  batch.set(pageRef, {
    title,
    description: draft.description.trim().slice(0, 280),
    active: Boolean(draft.active),
    currency: 'INR',
    ownerUid: uid,
    ownerName: owner.name,
    ownerUpiId: ownerUpiId || deleteField(),
    recipients: nextRecipients,
    totalAmount: nextRecipients.reduce((sum, row) => sum + row.amount, 0),
    updatedAt: serverTimestamp(),
    ...(existingSnapshot.exists() ? {} : { createdAt: serverTimestamp() }),
  }, { merge: true })

  recipients.forEach((row) => {
    const publicRow = nextRecipients.find((candidate) => candidate.id === row.id)!
    if (!row.phone) return
    batch.set(doc(database, 'splitPages', splitId, 'contacts', row.id), {
      recipientId: row.id,
      name: row.name,
      phone: toE164(row.phone),
      updatedAt: serverTimestamp(),
    })

    const existingRecipient = existingRecipients.get(row.id)
    if (existingRecipient?.status === 'paid' || !publicRow.ledgerEntryId) return

    const entryId = publicRow.ledgerEntryId!
    const entryRef = doc(database, 'ledgerEntries', entryId)
    const existingLedgerEntry = existingLedgerEntries.get(entryId)
    const paidAmount = publicRow.status === 'paid'
      ? row.amount
      : existingLedgerEntry ? entryPaidAmount(existingLedgerEntry) : 0
    if (row.amount < paidAmount) throw new Error(`${row.name}'s share cannot be less than approved payments.`)
    const remainingAmount = Math.max(0, row.amount - paidAmount)
    const status = remainingAmount === 0 ? 'paid' : paidAmount > 0 ? 'partially_paid' : 'open'
    const entry: Omit<LedgerEntry, 'id'> & Record<string, unknown> = {
      lender: { name: owner.name, phone: toE164(owner.phone) },
      borrower: { name: row.name, phone: toE164(row.phone) },
      lenderPhone: toE164(owner.phone),
      borrowerPhone: toE164(row.phone),
      participantPhones: [toE164(owner.phone), toE164(row.phone)],
      amount: row.amount,
      originalAmount: row.amount,
      paidAmount,
      remainingAmount,
      occasion: title,
      method: 'Personal funds',
      date: new Date().toISOString().slice(0, 10),
      status,
      createdBy: uid,
      updatedAt: serverTimestamp(),
    }
    // A member imported without a phone number has no due yet; adding the
    // number later creates it here, so key "new" off the due, not the member.
    const ledgerExists = Boolean(existingLedgerEntry)
    if (!ledgerExists) {
      entry.createdAt = serverTimestamp()
      entry.historyStarted = false
    }
    batch.set(entryRef, entry, { merge: ledgerExists })
    const activityEntry = { id: entryId, ...entry } as LedgerEntry
    const activity = activityDocument(
      activityEntry,
      uid,
      owner,
      ledgerExists ? 'due_edited' : 'due_created',
      entryId,
      { amount: row.amount, status },
    )
    batch.set(activity.ref, activity.data)
  })

  for (const oldRecipient of existingPage?.recipients || []) {
    if (nextRecipients.some((row) => row.id === oldRecipient.id)) continue
    batch.delete(doc(database, 'splitPages', splitId, 'contacts', oldRecipient.id))
    // A member added by name only never had a due, so there is nothing to close.
    const oldEntry = oldRecipient.ledgerEntryId ? existingLedgerEntries.get(oldRecipient.ledgerEntryId) : null
    if (oldEntry && oldRecipient.status !== 'paid') {
      const originalAmount = entryOriginalAmount(oldEntry)
      batch.update(doc(database, 'ledgerEntries', oldEntry.id), {
        originalAmount,
        paidAmount: originalAmount,
        remainingAmount: 0,
        status: 'paid',
        settledAt: new Date().toISOString(),
        updatedAt: serverTimestamp(),
      })
      const activity = activityDocument(
        { ...oldEntry, originalAmount, paidAmount: originalAmount, remainingAmount: 0, status: 'paid' },
        uid,
        owner,
        'due_marked_paid',
        oldEntry.id,
        { amount: Math.max(0, originalAmount - entryPaidAmount(oldEntry)), status: 'paid' },
      )
      batch.set(activity.ref, activity.data)
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
    const entryRef = recipient.ledgerEntryId ? doc(database, 'ledgerEntries', recipient.ledgerEntryId) : null
    const entrySnapshot = entryRef ? await transaction.get(entryRef) : null
    const paidAt = new Date().toISOString()
    transaction.update(pageRef, {
      recipients: page.recipients.map((row) => row.id === recipientId ? { ...row, status: 'paid', paidAt } : row),
      updatedAt: serverTimestamp(),
    })
    if (entryRef && entrySnapshot?.exists()) {
      const entry = { id: entrySnapshot.id, ...entrySnapshot.data() } as LedgerEntry
      const originalAmount = entryOriginalAmount(entry)
      const remainingAmount = Math.max(0, originalAmount - entryPaidAmount(entry))
      transaction.update(entryRef, {
        originalAmount,
        paidAmount: originalAmount,
        remainingAmount: 0,
        status: 'paid',
        settledAt: paidAt,
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
