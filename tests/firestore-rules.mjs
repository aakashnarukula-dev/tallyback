import { readFile } from 'node:fs/promises'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'
import {
  collection,
  doc,
  getDoc,
  getDocs,
  or,
  query,
  setDoc,
  where,
} from 'firebase/firestore'

const projectId = 'demo-tallyback'
const uid = 'truecaller-user'
const phone = '+919177216132'
const otherPhone = '+917729944442'

const testEnvironment = await initializeTestEnvironment({
  projectId,
  firestore: {
    rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8'),
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

  const smsDatabase = testEnvironment
    .authenticatedContext('sms-user', { phone_number: otherPhone })
    .firestore()
  const smsQuery = query(
    collection(smsDatabase, 'ledgerEntries'),
    or(
      where('lenderPhone', '==', otherPhone),
      where('borrowerPhone', '==', otherPhone),
    ),
  )
  await assertSucceeds(getDocs(smsQuery))

  const strangerDatabase = testEnvironment
    .authenticatedContext('stranger', { verifiedPhone: '+919999999999' })
    .firestore()
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

  console.log('Firestore rules: Truecaller and SMS participant queries passed; a legacy claimless session was rejected.')
} finally {
  await testEnvironment.cleanup()
}
