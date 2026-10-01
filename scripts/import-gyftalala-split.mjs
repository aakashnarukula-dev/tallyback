// One-off import of a Gyftalala split page into a TallyBack split.
//
// Reads splitPages/<slug> (and its private contacts) from the Gyftalala
// Firebase project and writes the same people, amounts and paid status as a
// TallyBack split owned by the account with --owner-phone. It writes exactly
// what the app's saveSplitPage + markSplitRecipientPaid would: the split page,
// its private contacts, one ledger entry per person and their activity rows.
// The owner is listed with their own share, already paid and with no due, the
// same as on Gyftalala: a split's total is the whole group's cost.
//
// If the TallyBack split already exists, only the people it is missing are
// added; everyone already in it is left exactly as it is.
//
// Gyftalala is only read. Runs as a dry run unless --write is passed.
//
//   node scripts/import-gyftalala-split.mjs --slug kishore-wedding-gift --owner-phone 9177216132 [--phone "Name=9876543210"] [--write]
//
// Credentials come from Application Default Credentials (gcloud auth
// application-default login). When the two projects belong to different Google
// accounts, point GYFTALALA_CREDENTIALS and/or TALLYBACK_CREDENTIALS at a saved
// copy of each account's application_default_credentials.json.
// GYFTALALA_PROJECT / TALLYBACK_PROJECT override the project ids.

import { Firestore } from '@google-cloud/firestore'
import { applicationDefault, initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore'

const args = process.argv.slice(2)
const arg = (name) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}
const slug = arg('slug')
const splitId = arg('split-id') || slug
const ownerPhoneArg = arg('owner-phone')
const write = args.includes('--write')
// --phone "Name=9876543210" (repeatable) fills a number Gyftalala doesn't have.
const phoneOverrides = new Map(args
  .flatMap((value, index) => (args[index - 1] === '--phone' ? [value] : []))
  .map((pair) => {
    const at = pair.lastIndexOf('=')
    return [pair.slice(0, at).trim().toLowerCase(), String(pair.slice(at + 1)).replace(/\D/g, '').slice(-10)]
  }))
if (!slug || !ownerPhoneArg) {
  console.error('Usage: --slug <gyftalala slug> --owner-phone <10-digit phone> [--split-id <id>] [--write]')
  process.exit(1)
}

const useEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST)
const database = (name, projectId, keyFilename) => {
  if (keyFilename && !useEmulator) return new Firestore({ projectId, keyFilename })
  return getFirestore(initializeApp(useEmulator ? { projectId } : { projectId, credential: applicationDefault() }, name))
}
const gyftalala = database('gyftalala', process.env.GYFTALALA_PROJECT || 'gyftalala-new', process.env.GYFTALALA_CREDENTIALS)
const tallyback = database('tallyback', process.env.TALLYBACK_PROJECT || 'tally-back', process.env.TALLYBACK_CREDENTIALS)

const digits10 = (value) => String(value || '').replace(/\D/g, '').slice(-10)
const toE164 = (value) => `+91${digits10(value)}`
const toIso = (value) => {
  if (!value) return undefined
  if (value instanceof Timestamp) return value.toDate().toISOString()
  if (typeof value.toDate === 'function') return value.toDate().toISOString()
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}
const memberId = (gyftalalaId) => `member-${String(gyftalalaId).replace(/^guest_/, '').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 24)}`
const ledgerId = (recipientId) => `split-${splitId}-${recipientId}`.slice(0, 180)

// --- Read Gyftalala -------------------------------------------------------
console.log('Reading the Gyftalala split…')
const sourceRef = gyftalala.collection('splitPages').doc(slug)
const sourceSnapshot = await sourceRef.get()
if (!sourceSnapshot.exists) throw new Error(`Gyftalala split ${slug} was not found.`)
const source = sourceSnapshot.data()
if (source.redirectTo) throw new Error(`Gyftalala split ${slug} is a redirect to ${source.redirectTo}.`)
const contactsSnapshot = await sourceRef.collection('contacts').get()
const contacts = new Map(contactsSnapshot.docs.map((item) => [item.id, item.data()]))

const sourceRows = (source.recipients || []).map((row) => {
  const amount = Number(row.amountPaise) / 100
  const phone = digits10(contacts.get(String(row.id))?.phone) || phoneOverrides.get(String(row.name || '').trim().toLowerCase()) || ''
  return {
    sourceId: String(row.id),
    name: String(row.name || '').trim(),
    amount,
    phone,
    paid: row.status === 'paid',
    paidAt: toIso(row.paidAt),
  }
})
console.log(`Gyftalala "${source.title}" (${source.active ? 'live' : 'hidden'}), ₹${Number(source.totalAmountPaise) / 100} requested:`)
for (const row of sourceRows) console.log(`  ${row.paid ? 'paid   ' : 'pending'} ₹${row.amount}  ${row.name}${row.phone ? '' : '  (no contact number)'}`)

// --- Resolve the TallyBack owner -------------------------------------------
console.log('Reading TallyBack…')
const ownerPhone = toE164(ownerPhoneArg)
const usersSnapshot = await tallyback.collection('users').where('phone', 'in', [ownerPhone, digits10(ownerPhone)]).get()
if (usersSnapshot.size !== 1) throw new Error(`Expected one TallyBack user with phone ${ownerPhone}, found ${usersSnapshot.size}.`)
const ownerUid = usersSnapshot.docs[0].id
const ownerName = String(usersSnapshot.docs[0].data().name || '').trim()
const upiSnapshot = await tallyback.collection('upiProfiles').doc(ownerPhone).get()
const ownerUpiId = upiSnapshot.exists && typeof upiSnapshot.data().upiId === 'string' ? upiSnapshot.data().upiId : null
console.log(`TallyBack owner: ${ownerName} (${ownerUid})${ownerUpiId ? `, UPI ${ownerUpiId}` : ', no UPI ID saved'}`)

// The owner's own share is part of the group's total, but it is not a due
// anyone owes them, so it is written as paid with no ledger entry.
const ownRow = sourceRows.find((row) => row.phone === digits10(ownerPhone))
if (ownRow) {
  ownRow.owner = true
  ownRow.paid = true
  console.log(`${ownRow.name}'s own ₹${ownRow.amount} share is the owner's: listed as paid, no due.`)
}
const allRows = sourceRows
const problems = allRows.filter((row) => !row.name || !(row.amount > 0) || (row.phone && row.phone.length !== 10))
if (problems.length) throw new Error(`Rows without a name or amount, or with a bad phone: ${problems.map((row) => row.name || row.sourceId).join(', ')}`)
const phones = allRows.map((row) => row.phone).filter(Boolean)
if (new Set(phones).size !== phones.length) throw new Error('Two people share a phone number.')
// Without a number there is no one to hold a due, so such a member is added to
// the split by name only. Typing their number into the split in the app later
// creates their due.
const noPhone = allRows.filter((row) => !row.phone)
if (noPhone.length) console.log(`Adding by name only (add their number in the app later): ${noPhone.map((row) => row.name).join(', ')}`)
if (!allRows.length || allRows.length > 50) throw new Error(`A split needs 1–50 people, found ${allRows.length}.`)

const pageRef = tallyback.collection('splitPages').doc(splitId)
const existingSnapshot = await pageRef.get()
const existing = existingSnapshot.exists ? existingSnapshot.data() : null
if (existing && existing.ownerUid !== ownerUid) throw new Error(`TallyBack split ${splitId} belongs to someone else; nothing written.`)
const existingIds = new Set((existing?.recipients || []).map((row) => row.id))
const rows = allRows.filter((row) => !existingIds.has(memberId(row.sourceId)))
if (existing) console.log(`TallyBack split ${splitId} already exists with ${existingIds.size} people; adding the ${rows.length} it is missing.`)
if (!rows.length) {
  console.log('Nothing to add.')
  process.exit(0)
}

// --- Build the TallyBack documents ------------------------------------------
const createdAtIso = toIso(source.createdAt) || new Date().toISOString()
const title = String(source.title || '').trim().slice(0, 100)
const recipients = rows.map((row) => {
  const id = memberId(row.sourceId)
  return {
    id,
    name: row.name.slice(0, 80),
    amount: row.amount,
    status: row.paid ? 'paid' : 'pending',
    ...(row.paid ? { paidAt: row.paidAt || createdAtIso } : {}),
    ...(row.owner ? {} : { ledgerEntryId: ledgerId(id) }),
  }
})
// Keep Gyftalala's order; anyone TallyBack has that Gyftalala doesn't stays last.
const sourceOrder = new Map(allRows.map((row, index) => [memberId(row.sourceId), index]))
const allRecipients = [...(existing?.recipients || []), ...recipients]
  .map((row, index) => ({ row, rank: sourceOrder.get(row.id) ?? allRows.length + index }))
  .sort((a, b) => a.rank - b.rank)
  .map(({ row }) => row)

const batch = tallyback.batch()
const totalAmount = allRecipients.reduce((sum, row) => sum + row.amount, 0)
if (existing) {
  batch.update(pageRef, { recipients: allRecipients, totalAmount, updatedAt: FieldValue.serverTimestamp() })
} else {
  batch.set(pageRef, {
    title,
    description: String(source.description || '').trim().slice(0, 280),
    active: Boolean(source.active),
    currency: 'INR',
    ownerUid,
    ownerName,
    ...(ownerUpiId ? { ownerUpiId } : {}),
    recipients,
    totalAmount,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })
}

const owner = { name: ownerName, phone: ownerPhone }
const activity = (entryId, entry, type, amount, status) => {
  batch.set(tallyback.collection('ledgerActivities').doc(), {
    dueId: entryId,
    sourceId: entryId,
    type,
    actorUid: ownerUid,
    actorPhone: ownerPhone,
    actorName: ownerName.slice(0, 120),
    lender: entry.lender,
    borrower: entry.borrower,
    lenderPhone: entry.lenderPhone,
    borrowerPhone: entry.borrowerPhone,
    participantPhones: entry.participantPhones,
    amount,
    eventDate: entry.date,
    method: entry.method,
    note: '',
    status,
    occurredAt: FieldValue.serverTimestamp(),
  })
}

rows.forEach((row, index) => {
  const recipient = recipients[index]
  if (!row.phone) return
  const phone = toE164(row.phone)
  batch.set(pageRef.collection('contacts').doc(recipient.id), {
    recipientId: recipient.id,
    name: recipient.name,
    phone,
    updatedAt: FieldValue.serverTimestamp(),
  })
  if (row.owner) return
  const entryId = recipient.ledgerEntryId
  const entry = {
    lender: owner,
    borrower: { name: recipient.name, phone },
    lenderPhone: ownerPhone,
    borrowerPhone: phone,
    participantPhones: [ownerPhone, phone],
    amount: row.amount,
    originalAmount: row.amount,
    paidAmount: 0,
    remainingAmount: row.amount,
    occasion: title,
    method: 'Personal funds',
    date: createdAtIso.slice(0, 10),
    status: 'open',
    historyStarted: false,
    createdBy: ownerUid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }
  activity(entryId, entry, 'due_created', row.amount, 'open')
  if (row.paid) {
    Object.assign(entry, { paidAmount: row.amount, remainingAmount: 0, status: 'paid', settledAt: recipient.paidAt })
    activity(entryId, entry, 'due_marked_paid', row.amount, 'paid')
  }
  batch.set(tallyback.collection('ledgerEntries').doc(entryId), entry)
})

console.log(`TallyBack split ${splitId}: ${allRecipients.length} people, ₹${totalAmount} total, ${allRecipients.filter((r) => r.status === 'paid').length} paid.`)
if (!write) {
  console.log('Dry run: nothing written. Re-run with --write to write it.')
} else {
  await batch.commit()
  console.log(`Written. Owner view: https://tally-back.web.app  Public page: https://tally-back.web.app/split/${splitId}`)
}
