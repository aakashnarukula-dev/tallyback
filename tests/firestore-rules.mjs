import { readFile } from 'node:fs/promises'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'
import {
  collection,
  deleteField,
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
  writeBatch,
} from 'firebase/firestore'
import {
  getMetadata,
  ref as storageRef,
  uploadString,
} from 'firebase/storage'

const projectId = 'demo-tallyback'
const lenderUid = 'lender-9177216132'
const borrowerUid = 'borrower-9154195668'
const lenderPhone = '+919177216132'
const borrowerPhone = '+919154195668'
const strangerPhone = '+919999999999'
const dueId = 'partial-payment-due'

const lender = { name: 'Aakash', phone: lenderPhone }
const borrower = { name: 'Borrower', phone: borrowerPhone }

const screenshot = (requestId, name = 'proof.png') => ({
  path: `ledgerEntries/${dueId}/${borrowerUid}/${requestId}-${name}`,
  name,
  contentType: 'image/png',
  size: 2048,
})

const repayment = (requestId, amount) => ({
  dueId,
  lenderId: lenderUid,
  lenderPhone,
  borrowerId: borrowerUid,
  borrowerPhone,
  participantPhones: [lenderPhone, borrowerPhone],
  payerName: borrower.name,
  amount,
  method: 'UPI',
  paidAt: '2026-09-21',
  proofScreenshots: [screenshot(requestId)],
  note: 'Paid offline',
  status: 'pending',
  createdAt: serverTimestamp(),
})

const activity = (type, actorUid, actorPhone, actorName, status, amount = 1000) => ({
  dueId,
  sourceId: `${type}-source`,
  type,
  actorUid,
  actorPhone,
  actorName,
  lender,
  borrower,
  lenderPhone,
  borrowerPhone,
  participantPhones: [lenderPhone, borrowerPhone],
  amount,
  eventDate: '2026-09-21',
  method: 'UPI',
  note: '',
  status,
  occurredAt: serverTimestamp(),
})

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
    await setDoc(doc(database, 'users', lenderUid), {
      name: lender.name,
      phone: lenderPhone,
      updatedAt: new Date(),
    })
    await setDoc(doc(database, 'users', borrowerUid), {
      name: borrower.name,
      phone: borrowerPhone,
      updatedAt: new Date(),
    })
    await setDoc(doc(database, 'ledgerEntries', dueId), {
      lender,
      borrower,
      lenderPhone,
      borrowerPhone,
      participantPhones: [lenderPhone, borrowerPhone],
      amount: 1000,
      originalAmount: 1000,
      paidAmount: 0,
      remainingAmount: 1000,
      occasion: 'Shared booking',
      method: 'UPI',
      date: '2026-09-20',
      status: 'open',
      createdBy: lenderUid,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await setDoc(doc(database, 'ledgerEntries', 'rejection-due'), {
      lender,
      borrower,
      lenderPhone,
      borrowerPhone,
      participantPhones: [lenderPhone, borrowerPhone],
      amount: 200,
      originalAmount: 200,
      paidAmount: 0,
      remainingAmount: 200,
      occasion: 'Rejected repayment',
      method: 'UPI',
      date: '2026-09-20',
      status: 'open',
      createdBy: lenderUid,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await setDoc(doc(database, 'ledgerEntries', 'already-paid-review-due'), {
      lender,
      borrower,
      lenderPhone,
      borrowerPhone,
      participantPhones: [lenderPhone, borrowerPhone],
      amount: 500,
      originalAmount: 500,
      paidAmount: 0,
      remainingAmount: 500,
      occasion: 'Already paid review',
      method: 'UPI',
      date: '2026-09-20',
      status: 'open',
      createdBy: lenderUid,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  })

  const lenderDatabase = testEnvironment
    .authenticatedContext(lenderUid, { phone_number: lenderPhone })
    .firestore()
  const borrowerDatabase = testEnvironment
    .authenticatedContext(borrowerUid, { phone_number: borrowerPhone })
    .firestore()
  const strangerDatabase = testEnvironment
    .authenticatedContext('stranger', { phone_number: strangerPhone })
    .firestore()

  await assertSucceeds(updateDoc(doc(lenderDatabase, 'users', lenderUid), {
    name: 'Aakash Updated',
    updatedAt: serverTimestamp(),
  }))
  await assertFails(updateDoc(doc(lenderDatabase, 'users', lenderUid), {
    name: 'TallyBack member',
    updatedAt: serverTimestamp(),
  }))

  const newDueId = 'canonical-new-due'
  const createDue = writeBatch(lenderDatabase)
  createDue.set(doc(lenderDatabase, 'ledgerEntries', newDueId), {
    lender: { ...lender, name: 'Aakash Updated' },
    borrower,
    lenderPhone,
    borrowerPhone,
    participantPhones: [lenderPhone, borrowerPhone],
    amount: 350,
    originalAmount: 350,
    paidAmount: 0,
    remainingAmount: 350,
    occasion: 'New due',
    method: 'UPI',
    date: '2026-09-21',
    status: 'open',
    createdBy: lenderUid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  createDue.set(doc(lenderDatabase, 'ledgerActivities', 'new-due-created'), {
    dueId: newDueId,
    sourceId: newDueId,
    type: 'due_created',
    actorUid: lenderUid,
    actorPhone: lenderPhone,
    actorName: 'Aakash Updated',
    lender: { ...lender, name: 'Aakash Updated' },
    borrower,
    lenderPhone,
    borrowerPhone,
    participantPhones: [lenderPhone, borrowerPhone],
    amount: 350,
    eventDate: '2026-09-21',
    method: 'UPI',
    note: '',
    status: 'open',
    occurredAt: serverTimestamp(),
  })
  await assertSucceeds(createDue.commit())
  const editDue = writeBatch(lenderDatabase)
  editDue.update(doc(lenderDatabase, 'ledgerEntries', newDueId), {
    amount: 400,
    originalAmount: 400,
    paidAmount: 0,
    remainingAmount: 400,
    occasion: 'Edited due',
    method: 'Bank transfer',
    date: '2026-09-22',
    status: 'open',
    updatedAt: serverTimestamp(),
  })
  editDue.set(doc(lenderDatabase, 'ledgerActivities', 'new-due-edited'), {
    dueId: newDueId,
    sourceId: newDueId,
    type: 'due_edited',
    actorUid: lenderUid,
    actorPhone: lenderPhone,
    actorName: 'Aakash Updated',
    lender: { ...lender, name: 'Aakash Updated' },
    borrower,
    lenderPhone,
    borrowerPhone,
    participantPhones: [lenderPhone, borrowerPhone],
    amount: 400,
    eventDate: '2026-09-22',
    method: 'Bank transfer',
    note: '',
    status: 'open',
    occurredAt: serverTimestamp(),
  })
  await assertSucceeds(editDue.commit())
  const markDuePaid = writeBatch(lenderDatabase)
  markDuePaid.update(doc(lenderDatabase, 'ledgerEntries', newDueId), {
    originalAmount: 400,
    paidAmount: 400,
    remainingAmount: 0,
    status: 'paid',
    settledAt: new Date().toISOString(),
    updatedAt: serverTimestamp(),
  })
  markDuePaid.set(doc(lenderDatabase, 'ledgerActivities', 'new-due-paid'), {
    dueId: newDueId,
    sourceId: newDueId,
    type: 'due_marked_paid',
    actorUid: lenderUid,
    actorPhone: lenderPhone,
    actorName: 'Aakash Updated',
    lender: { ...lender, name: 'Aakash Updated' },
    borrower,
    lenderPhone,
    borrowerPhone,
    participantPhones: [lenderPhone, borrowerPhone],
    amount: 400,
    eventDate: '2026-09-22',
    method: 'Bank transfer',
    note: '',
    status: 'paid',
    occurredAt: serverTimestamp(),
  })
  await assertSucceeds(markDuePaid.commit())

  const reviewId = 'already-paid-review'
  const reviewProof = {
    path: `ledgerEntries/already-paid-review-due/${borrowerUid}/already-paid.png`,
    name: 'already-paid.png',
    contentType: 'image/png',
    size: 2048,
  }
  const embeddedReview = {
    reviewId,
    requestedByUid: borrowerUid,
    requestedByPhone: borrowerPhone,
    kind: 'paid',
    proposedAmount: 0,
    proposedMethod: 'UPI',
    proposedOccasion: 'Already paid review',
    proposedDate: '2026-09-20',
    note: 'Paid in full',
    proofScreenshots: [reviewProof],
    status: 'pending',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
  const submitReview = writeBatch(borrowerDatabase)
  submitReview.update(doc(borrowerDatabase, 'ledgerEntries', 'already-paid-review-due'), {
    review: embeddedReview,
    updatedAt: serverTimestamp(),
  })
  submitReview.set(doc(borrowerDatabase, 'ledgerReviews', reviewId), {
    entryId: 'already-paid-review-due',
    entryCreatedBy: lenderUid,
    lender,
    borrower,
    lenderPhone,
    borrowerPhone,
    participantPhones: [lenderPhone, borrowerPhone],
    requestedByUid: borrowerUid,
    requestedByPhone: borrowerPhone,
    kind: 'paid',
    originalAmount: 500,
    originalMethod: 'UPI',
    originalOccasion: 'Already paid review',
    originalDate: '2026-09-20',
    proposedAmount: 0,
    proposedMethod: 'UPI',
    proposedOccasion: 'Already paid review',
    proposedDate: '2026-09-20',
    note: 'Paid in full',
    proofScreenshots: [reviewProof],
    status: 'pending',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  submitReview.set(doc(borrowerDatabase, 'ledgerActivities', 'already-paid-submitted'), {
    ...activity('repayment_submitted', borrowerUid, borrowerPhone, borrower.name, 'pending', 500),
    dueId: 'already-paid-review-due',
    sourceId: reviewId,
    lender,
    borrower,
  })
  await assertSucceeds(submitReview.commit())

  const approveReview = writeBatch(lenderDatabase)
  approveReview.update(doc(lenderDatabase, 'ledgerEntries', 'already-paid-review-due'), {
    review: deleteField(),
    originalAmount: 500,
    paidAmount: 500,
    remainingAmount: 0,
    status: 'paid',
    settledAt: new Date().toISOString(),
    updatedAt: serverTimestamp(),
  })
  approveReview.update(doc(lenderDatabase, 'ledgerReviews', reviewId), {
    status: 'approved',
    resolvedByUid: lenderUid,
    resolvedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  approveReview.set(doc(lenderDatabase, 'ledgerActivities', 'already-paid-accepted'), {
    ...activity('repayment_accepted', lenderUid, lenderPhone, lender.name, 'accepted', 500),
    dueId: 'already-paid-review-due',
    sourceId: reviewId,
    lender,
    borrower,
  })
  approveReview.set(doc(lenderDatabase, 'ledgerActivities', 'already-paid-completed'), {
    ...activity('due_marked_paid', lenderUid, lenderPhone, lender.name, 'paid', 500),
    dueId: 'already-paid-review-due',
    sourceId: reviewId,
    lender,
    borrower,
  })
  await assertSucceeds(approveReview.commit())
  const reviewedDue = await getDoc(doc(borrowerDatabase, 'ledgerEntries', 'already-paid-review-due'))
  const reviewHistory = await getDoc(doc(borrowerDatabase, 'ledgerReviews', reviewId))
  if (!reviewedDue.exists() || reviewedDue.data().status !== 'paid' || reviewHistory.data().status !== 'approved') {
    throw new Error('Accepted already-paid review did not retain paid due and approved review history.')
  }

  await assertSucceeds(getDoc(doc(lenderDatabase, 'ledgerEntries', dueId)))
  await assertSucceeds(getDoc(doc(borrowerDatabase, 'ledgerEntries', dueId)))
  await assertFails(getDoc(doc(strangerDatabase, 'ledgerEntries', dueId)))

  await assertSucceeds(setDoc(doc(borrowerDatabase, 'repaymentRequests', 'payment-400'), repayment('payment-400', 400)))
  await assertFails(setDoc(doc(borrowerDatabase, 'repaymentRequests', 'payment-too-large'), repayment('payment-too-large', 1001)))
  await assertFails(updateDoc(doc(borrowerDatabase, 'repaymentRequests', 'payment-400'), {
    status: 'accepted',
    reviewedAt: serverTimestamp(),
    reviewedBy: borrowerUid,
  }))

  await assertSucceeds(runTransaction(lenderDatabase, async (transaction) => {
    const requestRef = doc(lenderDatabase, 'repaymentRequests', 'payment-400')
    const entryRef = doc(lenderDatabase, 'ledgerEntries', dueId)
    await Promise.all([transaction.get(requestRef), transaction.get(entryRef)])
    transaction.update(requestRef, {
      status: 'accepted',
      reviewedAt: serverTimestamp(),
      reviewedBy: lenderUid,
    })
    transaction.update(entryRef, {
      originalAmount: 1000,
      paidAmount: 400,
      remainingAmount: 600,
      status: 'partially_paid',
      lastRepaymentId: 'payment-400',
      updatedAt: serverTimestamp(),
    })
  }))

  let entrySnapshot = await getDoc(doc(lenderDatabase, 'ledgerEntries', dueId))
  if (entrySnapshot.data().paidAmount !== 400 || entrySnapshot.data().remainingAmount !== 600) {
    throw new Error('First partial payment did not produce expected 400 paid / 600 remaining balance.')
  }

  await assertFails(runTransaction(lenderDatabase, async (transaction) => {
    const requestRef = doc(lenderDatabase, 'repaymentRequests', 'payment-400')
    const entryRef = doc(lenderDatabase, 'ledgerEntries', dueId)
    await Promise.all([transaction.get(requestRef), transaction.get(entryRef)])
    transaction.update(entryRef, {
      paidAmount: 800,
      remainingAmount: 200,
      lastRepaymentId: 'payment-400',
      updatedAt: serverTimestamp(),
    })
  }))

  await assertSucceeds(setDoc(doc(borrowerDatabase, 'repaymentRequests', 'payment-600'), repayment('payment-600', 600)))
  await assertSucceeds(runTransaction(lenderDatabase, async (transaction) => {
    const requestRef = doc(lenderDatabase, 'repaymentRequests', 'payment-600')
    const entryRef = doc(lenderDatabase, 'ledgerEntries', dueId)
    await Promise.all([transaction.get(requestRef), transaction.get(entryRef)])
    transaction.update(requestRef, {
      status: 'accepted',
      reviewedAt: serverTimestamp(),
      reviewedBy: lenderUid,
    })
    transaction.update(entryRef, {
      originalAmount: 1000,
      paidAmount: 1000,
      remainingAmount: 0,
      status: 'paid',
      settledAt: new Date().toISOString(),
      lastRepaymentId: 'payment-600',
      updatedAt: serverTimestamp(),
    })
  }))

  entrySnapshot = await getDoc(doc(lenderDatabase, 'ledgerEntries', dueId))
  if (!entrySnapshot.exists() || entrySnapshot.data().status !== 'paid' || entrySnapshot.data().remainingAmount !== 0) {
    throw new Error('Paid due was removed or retained an outstanding balance.')
  }

  await assertSucceeds(setDoc(doc(borrowerDatabase, 'repaymentRequests', 'payment-rejected'), {
    ...repayment('payment-rejected', 50),
    dueId: 'rejection-due',
    proofScreenshots: [{
      ...screenshot('payment-rejected'),
      path: `ledgerEntries/rejection-due/${borrowerUid}/proof.png`,
    }],
  }))
  await assertSucceeds(updateDoc(doc(lenderDatabase, 'repaymentRequests', 'payment-rejected'), {
    status: 'rejected',
    reviewedAt: serverTimestamp(),
    reviewedBy: lenderUid,
  }))

  await assertSucceeds(setDoc(doc(borrowerDatabase, 'ledgerActivities', 'borrower-submitted'), activity(
    'repayment_submitted',
    borrowerUid,
    borrowerPhone,
    borrower.name,
    'pending',
    400,
  )))
  await assertFails(setDoc(doc(borrowerDatabase, 'ledgerActivities', 'borrower-accepted'), activity(
    'repayment_accepted',
    borrowerUid,
    borrowerPhone,
    borrower.name,
    'accepted',
    400,
  )))
  await assertFails(setDoc(doc(borrowerDatabase, 'ledgerActivities', 'borrower-spoofed-name'), activity(
    'repayment_submitted',
    borrowerUid,
    borrowerPhone,
    'Spoofed borrower',
    'pending',
    400,
  )))
  await assertSucceeds(setDoc(doc(lenderDatabase, 'ledgerActivities', 'lender-accepted'), activity(
    'repayment_accepted',
    lenderUid,
    lenderPhone,
    lender.name,
    'accepted',
    400,
  )))

  const activityQuery = query(
    collection(borrowerDatabase, 'ledgerActivities'),
    or(
      where('lenderPhone', '==', borrowerPhone),
      where('borrowerPhone', '==', borrowerPhone),
    ),
  )
  await assertSucceeds(getDocs(activityQuery))
  await assertFails(getDocs(query(
    collection(strangerDatabase, 'ledgerActivities'),
    or(
      where('lenderPhone', '==', borrowerPhone),
      where('borrowerPhone', '==', borrowerPhone),
    ),
  )))

  await assertSucceeds(updateDoc(doc(borrowerDatabase, 'users', borrowerUid), {
    name: 'Borrower Updated',
    updatedAt: serverTimestamp(),
  }))
  await assertSucceeds(updateDoc(doc(borrowerDatabase, 'ledgerEntries', dueId), {
    'borrower.name': 'Borrower Updated',
    updatedAt: serverTimestamp(),
  }))

  await assertFails(updateDoc(doc(lenderDatabase, 'ledgerEntries', dueId), {
    borrowerPhone: strangerPhone,
    updatedAt: serverTimestamp(),
  }))

  const proofPath = `ledgerEntries/${dueId}/${borrowerUid}/storage-proof.png`
  const borrowerStorage = testEnvironment
    .authenticatedContext(borrowerUid, { phone_number: borrowerPhone })
    .storage('gs://demo-tallyback.firebasestorage.app')
  await assertSucceeds(uploadString(
    storageRef(borrowerStorage, proofPath),
    'payment-proof',
    'raw',
    { contentType: 'image/png' },
  ))
  const lenderStorage = testEnvironment
    .authenticatedContext(lenderUid, { phone_number: lenderPhone })
    .storage('gs://demo-tallyback.firebasestorage.app')
  await assertSucceeds(getMetadata(storageRef(lenderStorage, proofPath)))
  const strangerStorage = testEnvironment
    .authenticatedContext('stranger', { phone_number: strangerPhone })
    .storage('gs://demo-tallyback.firebasestorage.app')
  await assertFails(getMetadata(storageRef(strangerStorage, proofPath)))
  await assertFails(uploadString(
    storageRef(strangerStorage, `ledgerEntries/${dueId}/stranger/proof.png`),
    'not-allowed',
    'raw',
    { contentType: 'image/png' },
  ))

  console.log('Firestore and Storage rules: borrower submission, lender-only review, partial balances, duplicate protection, retained paid dues, activity visibility, immutable identities, and private proof access passed.')
} finally {
  await testEnvironment.cleanup()
}
