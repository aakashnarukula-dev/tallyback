import crypto from 'node:crypto'
import { allowCors, jsonBody } from '../_lib/http.js'
import { rateLimit } from '../_lib/rate-limit.js'
import { settleSplitPayment } from '../_lib/split-payment.js'

function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual || ''))
  const right = Buffer.from(String(expected || ''))
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right)
}

export default async function handler(req, res) {
  if (allowCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })
  if (!(await rateLimit(req, 'split-verify', 60))) return res.status(429).json({ error: 'rate_limited' })
  const body = jsonBody(req)
  const splitId = String(body.splitId || '')
  const recipientId = String(body.recipientId || '')
  const orderId = String(body.razorpay_order_id || '')
  const paymentId = String(body.razorpay_payment_id || '')
  const signature = String(body.razorpay_signature || '')
  if (!splitId || !recipientId || !orderId || !paymentId || !signature) return res.status(400).json({ error: 'invalid_request' })
  if (!process.env.RAZORPAY_KEY_SECRET) return res.status(503).json({ error: 'payment_unavailable' })

  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex')
  if (!safeEqual(signature, expected)) return res.status(401).json({ error: 'invalid_signature' })
  try {
    await settleSplitPayment({ splitId, recipientId, orderId, paymentId, source: 'checkout' })
    return res.status(200).json({ ok: true })
  } catch (error) {
    console.error('[split-payment/verify]', error?.message || error)
    return res.status(409).json({ error: error?.message || 'verification_failed' })
  }
}
