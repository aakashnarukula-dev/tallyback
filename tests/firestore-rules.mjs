import { readFile } from 'node:fs/promises'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  or,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore'
import {
  getMetadata,
  ref as storageRef,
  uploadString,
} from 'firebase/storage'

const projectId = 'demo-tallyback'
const uid = 'truecaller-user'
const phone = '+919177216132'
const otherPhone = '+917729944442'

const testEnvironment = await initializeTestEnvironment({
  projectId,
  firestore: {
    rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8'),
  },
  storage: {
    rules: await readFile(new URL('../storage.rules', import.meta.url), 'utf8'),
  },
})

try {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    const database = context.firestore()
    await setDoc(doc(database, 'users', uid), {
      name: 'Aakash Work',
      phone,
      updatedAt: new Date(),
    })
    await setDoc(doc(database, 'ledgerEntries', 'saved-entry'), {
      lender: { name: 'Aakash Work', phone },
      borrower: { name: 'Aakash 2', phone: otherPhone },
      lenderPhone: phone,
      borrowerPhone: otherPhone,
      participantPhones: [phone, otherPhone],
      amount: 100,
      occasion: 'Tickets',
      method: 'UPI',
      date: '2026-09-07',
      status: 'open',
      createdBy: uid,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  })

  const truecallerDatabase = testEnvironment
    .authenticatedContext(uid, { loginMethod: 'truecaller', verifiedPhone: phone })
    .firestore()

  await assertSucceeds(getDoc(doc(truecallerDatabase, 'ledgerEntries', 'saved-entry')))
  const ledgerQuery = query(
    collection(truecallerDatabase, 'ledgerEntries'),
    or(
      where('lenderPhone', '==', phone),
      where('borrowerPhone', '==', phone),
    ),
  )
  const snapshot = await assertSucceeds(getDocs(ledgerQuery))
  if (snapshot.size !== 1) {
    throw new Error(`Expected one ledger entry, received ${snapshot.size}.`)
  }

  const contactPath = `users/${uid}/contacts/7729944442`
  await assertSucceeds(setDoc(doc(truecallerDatabase, contactPath), {
    name: 'Aakash 2',
    phone: otherPhone,
    source: 'device',
    updatedAt: serverTimestamp(),
  }))
  await assertSucceeds(getDocs(collection(truecallerDatabase, 'users', uid, 'contacts')))
  await assertFails(setDoc(doc(truecallerDatabase, `users/${uid}/contacts/not-a-phone`), {
    name: 'Invalid contact',
    phone: '+91not-a-phone',
    source: 'manual',
    updatedAt: serverTimestamp(),
  }))

  const splitId = 'goa-trip-unit123'
  const recipientId = 'member-unit123'
  const splitEntryId = `split-${splitId}-${recipientId}`
  await assertSucceeds(setDoc(doc(truecallerDatabase, 'splitPages', splitId), {
    title: 'Goa trip',
    description: 'Shared travel costs',
    active: true,
    currency: 'INR',
    ownerUid: uid,
    ownerName: 'Aakash Work',
    recipients: [{ id: recipientId, name: 'Aakash 2', amount: 500, status: 'pending', ledgerEntryId: splitEntryId }],
    totalAmount: 500,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }))
  await assertSucceeds(setDoc(doc(truecallerDatabase, 'ledgerEntries', splitEntryId), {
    lender: { name: 'Aakash Work', phone },
    borrower: { name: 'Aakash 2', phone: otherPhone },
    lenderPhone: phone,
    borrowerPhone: otherPhone,
    participantPhones: [phone, otherPhone],
    amount: 500,
    occasion: 'Goa trip',
    method: 'Personal funds',
    date: '2026-09-19',
    status: 'open',
    createdBy: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }))
  await assertSucceeds(runTransaction(truecallerDatabase, async (transaction) => {
    const pageRef = doc(truecallerDatabase, 'splitPages', splitId)
    const pageSnapshot = await transaction.get(pageRef)
    const page = pageSnapshot.data()
    const paidAt = new Date().toISOString()
    transaction.update(pageRef, {
      recipients: page.recipients.map((recipient) => recipient.id === recipientId
        ? { ...recipient, status: 'paid', paidAt }
        : recipient),
      updatedAt: serverTimestamp(),
    })
    transaction.update(doc(truecallerDatabase, 'ledgerEntries', splitEntryId), {
      status: 'settled',
      settledAt: paidAt,
      updatedAt: serverTimestamp(),
    })
  }))
  await assertFails(deleteDoc(doc(truecallerDatabase, 'ledgerEntries', splitEntryId)))

  const attachmentEntry = {
    lender: { name: 'Aakash Work', phone },
    borrower: { name: 'Aakash 2', phone: otherPhone },
    lenderPhone: phone,
    borrowerPhone: otherPhone,
    participantPhones: [phone, otherPhone],
    amount: 250,
    occasion: 'Payment with proof',
    method: 'UPI',
    date: '2026-09-15',
    status: 'open',
    createdBy: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    screenshots: Array.from({ length: 5 }, (_, index) => ({
      path: `ledgerEntries/attachment-entry/${uid}/proof-${index + 1}.png`,
      name: `proof-${index + 1}.png`,
      contentType: 'image/png',
      size: 1024,
    })),
  }
  await assertSucceeds(setDoc(
    doc(truecallerDatabase, 'ledgerEntries', 'attachment-entry'),
    attachmentEntry,
  ))

  const smsDatabase = testEnvironment
    .authenticatedContext('sms-user', { phone_number: otherPhone })
    .firestore()
  await assertSucceeds(updateDoc(doc(truecallerDatabase, 'ledgerEntries', 'attachment-entry'), {
    amount: 275,
    occasion: 'Updated payment with proof',
    screenshots: attachmentEntry.screenshots.slice(0, 4),
    updatedAt: serverTimestamp(),
  }))
  await assertFails(updateDoc(doc(smsDatabase, 'ledgerEntries', 'attachment-entry'), {
    amount: 1,
    updatedAt: serverTimestamp(),
  }))
  const smsQuery = query(
    collection(smsDatabase, 'ledgerEntries'),
    or(
      where('lenderPhone', '==', otherPhone),
      where('borrowerPhone', '==', otherPhone),
    ),
  )
  await assertSucceeds(getDocs(smsQuery))
  await assertSucceeds(getDoc(doc(smsDatabase, 'ledgerEntries', splitEntryId)))

  const strangerDatabase = testEnvironment
    .authenticatedContext('stranger', { verifiedPhone: '+919999999999' })
    .firestore()
  await assertFails(getDocs(collection(strangerDatabase, 'users', uid, 'contacts')))
  await assertFails(setDoc(doc(strangerDatabase, contactPath), {
    name: 'Changed by stranger',
    phone: otherPhone,
    source: 'manual',
    updatedAt: serverTimestamp(),
  }))
  await assertFails(deleteDoc(doc(strangerDatabase, contactPath)))
  await assertSucceeds(deleteDoc(doc(truecallerDatabase, contactPath)))
  const strangerQuery = query(
    collection(strangerDatabase, 'ledgerEntries'),
    or(
      where('lenderPhone', '==', phone),
      where('borrowerPhone', '==', phone),
    ),
  )
  await assertFails(getDocs(strangerQuery))

  const legacyTruecallerDatabase = testEnvironment
    .authenticatedContext(uid, { loginMethod: 'truecaller' })
    .firestore()
  const legacyQuery = query(
    collection(legacyTruecallerDatabase, 'ledgerEntries'),
    or(
      where('lenderPhone', '==', phone),
      where('borrowerPhone', '==', phone),
    ),
  )
  await assertFails(getDocs(legacyQuery))

  const proofPath = `ledgerEntries/saved-entry/${uid}/proof.png`
  const truecallerStorage = testEnvironment
    .authenticatedContext(uid, { loginMethod: 'truecaller', verifiedPhone: phone })
    .storage('gs://demo-tallyback.firebasestorage.app')
  await assertSucceeds(uploadString(
    storageRef(truecallerStorage, proofPath),
    'payment-proof',
    'raw',
    { contentType: 'image/png' },
  ))

  const borrowerStorage = testEnvironment
    .authenticatedContext('sms-user', { phone_number: otherPhone })
    .storage('gs://demo-tallyback.firebasestorage.app')
  await assertSucceeds(getMetadata(storageRef(borrowerStorage, proofPath)))

  const strangerStorage = testEnvironment
    .authenticatedContext('stranger', { verifiedPhone: '+919999999999' })
    .storage('gs://demo-tallyback.firebasestorage.app')
  await assertFails(getMetadata(storageRef(strangerStorage, proofPath)))
  await assertFails(uploadString(
    storageRef(truecallerStorage, `ledgerEntries/saved-entry/${uid}/not-an-image.txt`),
    'not-an-image',
    'raw',
    { contentType: 'text/plain' },
  ))

  await assertFails(deleteDoc(doc(smsDatabase, 'ledgerEntries', 'saved-entry')))
  await assertSucceeds(deleteDoc(doc(truecallerDatabase, 'ledgerEntries', 'saved-entry')))

  console.log('Firestore and Storage rules: private contacts, unified split dues, creator-only due edits and deletion, participant ledgers, and payment proofs passed.')
} finally {
  await testEnvironment.cleanup()
}
