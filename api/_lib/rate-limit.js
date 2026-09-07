import crypto from 'node:crypto'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from './firebase-admin.js'

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim()
}

export async function rateLimit(req, bucket, max = 30, windowMs = 60 * 60 * 1000) {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs
  const key = crypto.createHash('sha256').update(`${bucket}:${clientIp(req)}:${windowStart}`).digest('hex')
  const ref = adminDb().collection('rateLimits').doc(key)
  return adminDb().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref)
    const count = Number(snapshot.data()?.count || 0)
    if (count >= max) return false
    transaction.set(ref, {
      bucket,
      count: count + 1,
      expiresAt: new Date(windowStart + windowMs * 2),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    return true
  }).catch(() => true)
}
