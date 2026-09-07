import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from './firebase-admin.js'

export async function settleSplitPayment({ splitId, recipientId, orderId, paymentId, source }) {
  const database = adminDb()
  const pageRef = database.collection('splitPages').doc(splitId)
  const paymentRef = pageRef.collection('payments').doc(recipientId)

  return database.runTransaction(async (transaction) => {
    const [pageSnapshot, paymentSnapshot] = await Promise.all([
      transaction.get(pageRef),
      transaction.get(paymentRef),
    ])
    if (!pageSnapshot.exists || !paymentSnapshot.exists) throw new Error('split_not_found')
    const page = pageSnapshot.data() || {}
    const payment = paymentSnapshot.data() || {}
    if (String(payment.razorpayOrderId || '') !== orderId) throw new Error('order_mismatch')
    const recipients = Array.isArray(page.recipients) ? page.recipients : []
    const recipient = recipients.find((row) => String(row?.id || '') === recipientId)
    if (!recipient) throw new Error('recipient_not_found')
    if (recipient.status === 'paid') return { alreadyPaid: true }

    const paidAt = new Date().toISOString()
    transaction.update(pageRef, {
      recipients: recipients.map((row) => row.id === recipientId ? { ...row, status: 'paid', paidAt } : row),
      updatedAt: FieldValue.serverTimestamp(),
    })
    transaction.set(paymentRef, {
      status: 'paid',
      razorpayPaymentId: paymentId,
      source,
      paidAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    if (recipient.ledgerEntryId) {
      transaction.set(database.collection('ledgerEntries').doc(recipient.ledgerEntryId), {
        status: 'settled',
        settledAt: paidAt,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
    }
    return { alreadyPaid: false }
  })
}
