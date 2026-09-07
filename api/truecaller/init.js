import { allowCors } from '../_lib/http.js'
import { rateLimit } from '../_lib/rate-limit.js'
import { createNonce, storePendingNonce, truecallerDeeplink } from '../_lib/truecaller.js'

export default async function handler(req, res) {
  if (allowCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })
  if (!(await rateLimit(req, 'truecaller-init', 20))) return res.status(429).json({ error: 'rate_limited' })
  try {
    const nonce = createNonce()
    await storePendingNonce(nonce)
    return res.status(200).json({ nonce, deeplink: truecallerDeeplink(nonce), ttlSeconds: 600 })
  } catch (error) {
    console.error('[truecaller/init]', error?.message || error)
    return res.status(503).json({ error: 'not_configured' })
  }
}
