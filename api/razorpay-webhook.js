import crypto from 'node:crypto'
import { adminDb } from './_lib/firebase-admin.js'
import { settleSplitPayment } from './_lib/split-payment.js'

export const config = { api: { bodyParser: false } }

async function readRaw(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual || ''))
  const right = Buffer.from(String(expected || ''))
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) return res.status(503).json({ error: 'webhook_not_configured' })
  try {
    const raw = await readRaw(req)
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex')
    if (!safeEqual(req.headers['x-razorpay-signature'], expected)) return res.status(401).json({ error: 'invalid_signature' })
    const event = JSON.parse(raw.toString('utf8'))
    if (!['payment.captured', 'order.paid'].includes(event.event)) return res.status(200).json({ ok: true, ignored: true })
    const payment = event.payload?.payment?.entity
    const orderId = String(payment?.order_id || '')
    const paymentId = String(payment?.id || '')
    if (!orderId || !paymentId) return res.status(200).json({ ok: true, ignored: true })

    const matches = await adminDb().collectionGroup('payments').where('razorpayOrderId', '==', orderId).limit(1).get()
    if (matches.empty) return res.status(200).json({ ok: true, unmatched: true })
    const paymentDoc = matches.docs[0]
    const pageRef = paymentDoc.ref.parent.parent
    if (!pageRef) return res.status(200).json({ ok: true, unmatched: true })
    await settleSplitPayment({ splitId: pageRef.id, recipientId: paymentDoc.id, orderId, paymentId, source: 'webhook' })
    return res.status(200).json({ ok: true })
  } catch (error) {
    console.error('[razorpay-webhook]', error?.message || error)
    return res.status(500).json({ error: 'internal' })
  }
}
