import { allowCors } from '../_lib/http.js'
import { adminAuth, adminDb } from '../_lib/firebase-admin.js'
import { verifyActiveSession } from '../_lib/auth-session.js'

export default async function handler(req, res) {
  if (allowCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })
  const authorization = String(req.headers.authorization || '')
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  if (!token) return res.status(401).json({ error: 'missing_token' })

  let decoded
  try {
    decoded = await verifyActiveSession(token)
  } catch (error) {
    console.error('[auth/signout-all/verify]', error?.code || 'verification_failed')
    const unauthorized = String(error?.code || '').startsWith('auth/')
    return res.status(unauthorized ? 401 : 503).json({ error: unauthorized ? 'invalid_session' : 'signout_unavailable' })
  }

  try {
    // Only the verified caller's UID is used; request bodies cannot target another account.
    await adminAuth().revokeRefreshTokens(decoded.uid)
    const user = await adminAuth().getUser(decoded.uid)
    const revokedBefore = Math.floor(new Date(user.tokensValidAfterTime).getTime() / 1000)
    if (!Number.isFinite(revokedBefore)) throw new Error('Missing revocation time')
    const sessionRef = adminDb().collection('authSessions').doc(decoded.uid)
    await adminDb().runTransaction(async (transaction) => {
      const previous = await transaction.get(sessionRef)
      // Concurrent calls must never move the cutoff backwards.
      transaction.set(sessionRef, {
        revokedBefore: Math.max(revokedBefore, previous.data()?.revokedBefore || 0),
      })
    })
    return res.status(200).json({ ok: true })
  } catch (error) {
    console.error('[auth/signout-all]', error?.code || 'revocation_failed')
    return res.status(503).json({ error: 'signout_unavailable' })
  }
}
