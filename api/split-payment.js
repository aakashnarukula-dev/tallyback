import crypto from 'node:crypto'
import Razorpay from 'razorpay'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from './_lib/firebase-admin.js'
import { allowCors, jsonBody } from './_lib/http.js'
import { rateLimit } from './_lib/rate-limit.js'

function gateway() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) throw new Error('payment_unavailable')
  return new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
}

function validId(value) {
  const id = String(value || '')
  return /^[a-z0-9-]{3,180}$/i.test(id) ? id : null
}

export default async function handler(req, res) {
  if (allowCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })
  if (!(await rateLimit(req, 'split-payment', 30))) return res.status(429).json({ error: 'rate_limited' })

  const body = jsonBody(req)
  const splitId = validId(body.splitId)
  const recipientId = validId(body.recipientId)
  if (!splitId || !recipientId) return res.status(400).json({ error: 'invalid_request' })

  try {
    const database = adminDb()
    const pageRef = database.collection('splitPages').doc(splitId)
    const [pageSnapshot, contactSnapshot, paymentSnapshot] = await Promise.all([
      pageRef.get(),
      pageRef.collection('contacts').doc(recipientId).get(),
      pageRef.collection('payments').doc(recipientId).get(),
    ])
    if (!pageSnapshot.exists) return res.status(404).json({ error: 'split_not_found' })
    const page = pageSnapshot.data() || {}
    if (page.active !== true) return res.status(410).json({ error: 'split_inactive' })
    const recipient = (Array.isArray(page.recipients) ? page.recipients : []).find((row) => row.id === recipientId)
    if (!recipient) return res.status(404).json({ error: 'recipient_not_found' })
    if (recipient.status === 'paid') return res.status(409).json({ error: 'already_paid' })
    const amount = Math.round(Number(recipient.amount) * 100)
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 10_000_000) return res.status(400).json({ error: 'invalid_amount' })

    const existing = paymentSnapshot.data() || {}
    if (existing.status === 'created' && existing.razorpayOrderId && Number(existing.amountPaise) === amount) {
      return res.status(200).json({
        orderId: existing.razorpayOrderId,
        keyId: process.env.RAZORPAY_KEY_ID,
        amount,
        prefillContact: contactSnapshot.data()?.phone || '',
      })
    }

    const receipt = `tb_${crypto.createHash('sha256').update(`${splitId}:${recipientId}:${amount}`).digest('hex').slice(0, 27)}`
    const order = await gateway().orders.create({ amount, currency: 'INR', receipt })
    await pageRef.collection('payments').doc(recipientId).set({
      splitId,
      recipientId,
      recipientName: recipient.name,
      amountPaise: amount,
      status: 'created',
      razorpayOrderId: order.id,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })

    return res.status(200).json({
      orderId: order.id,
      keyId: process.env.RAZORPAY_KEY_ID,
      amount,
      prefillContact: contactSnapshot.data()?.phone || '',
    })
  } catch (error) {
    console.error('[split-payment/create]', error?.message || error)
    return res.status(503).json({ error: error?.message === 'payment_unavailable' ? 'payment_unavailable' : 'internal' })
  }
}
