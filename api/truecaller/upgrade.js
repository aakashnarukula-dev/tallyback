import { allowCors } from '../_lib/http.js'
import { adminAuth, adminDb } from '../_lib/firebase-admin.js'
import { rateLimit } from '../_lib/rate-limit.js'

function bearerToken(req) {
  const authorization = String(req.headers.authorization || '')
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
}

export default async function handler(req, res) {
  if (allowCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })
  if (!(await rateLimit(req, 'truecaller-upgrade', 10))) return res.status(429).json({ error: 'rate_limited' })

  try {
    const idToken = bearerToken(req)
    if (!idToken) return res.status(401).json({ error: 'missing_token' })

    const decoded = await adminAuth().verifyIdToken(idToken)
    const isCustomSession = decoded.firebase?.sign_in_provider === 'custom'
    if (decoded.loginMethod !== 'truecaller' && !isCustomSession) {
      return res.status(403).json({ error: 'not_truecaller' })
    }

    const profile = await adminDb().collection('users').doc(decoded.uid).get()
    const verifiedPhone = String(profile.data()?.phone || '')
    if (!/^\+91\d{10}$/.test(verifiedPhone)) return res.status(409).json({ error: 'missing_verified_phone' })

    const user = await adminAuth().getUser(decoded.uid)
    await adminAuth().setCustomUserClaims(decoded.uid, {
      ...(user.customClaims || {}),
      loginMethod: 'truecaller',
      verifiedPhone,
    })

    return res.status(200).json({ ok: true })
  } catch (error) {
    console.error('[truecaller/upgrade]', error?.code || error?.message || error)
    return res.status(401).json({ error: 'invalid_session' })
  }
}
