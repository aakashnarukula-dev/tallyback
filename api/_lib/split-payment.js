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

    const ledgerRef = recipient.ledgerEntryId
      ? database.collection('ledgerEntries').doc(recipient.ledgerEntryId)
      : null
    const ledgerSnapshot = ledgerRef ? await transaction.get(ledgerRef) : null
    const ledger = ledgerSnapshot?.exists ? ledgerSnapshot.data() || {} : null

    const paidAt = new Date().toISOString()
    const paidDate = paidAt.slice(0, 10)
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
    if (ledgerRef && ledger) {
      const originalAmount = Number(ledger.originalAmount ?? ledger.amount ?? recipient.amount)
      const previouslyPaid = Number(ledger.paidAmount ?? 0)
      const amountClosed = Math.max(0, originalAmount - previouslyPaid)
      transaction.set(ledgerRef, {
        originalAmount,
        paidAmount: originalAmount,
        remainingAmount: 0,
        status: 'paid',
        settledAt: paidAt,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
      transaction.set(database.collection('ledgerActivities').doc(), {
        dueId: ledgerRef.id,
        sourceId: paymentId,
        type: 'due_marked_paid',
        actorUid: `razorpay:${paymentId}`,
        actorPhone: String(ledger.borrowerPhone || ledger.borrower?.phone || ''),
        actorName: String(ledger.borrower?.name || 'Borrower'),
        lender: ledger.lender,
        borrower: ledger.borrower,
        lenderPhone: ledger.lenderPhone,
        borrowerPhone: ledger.borrowerPhone,
        participantPhones: ledger.participantPhones,
        amount: amountClosed || originalAmount,
        eventDate: paidDate,
        method: ledger.method || 'Personal funds',
        note: 'Paid online through Razorpay',
        status: 'paid',
        occurredAt: FieldValue.serverTimestamp(),
      })
    }
    return { alreadyPaid: false }
  })
}
