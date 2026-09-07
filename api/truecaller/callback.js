import crypto from 'node:crypto'
import { jsonBody } from '../_lib/http.js'
import { rateLimit } from '../_lib/rate-limit.js'
import {
  createFirebaseSession,
  indianPhone,
  markNonce,
  readNonce,
  truecallerEndpointAllowed,
} from '../_lib/truecaller.js'

function secretMatches(req, body) {
  const expected = process.env.TRUECALLER_CALLBACK_SECRET
  if (!expected) return true
  const provided = String(req.query?.cbs || req.headers['x-callback-secret'] || body?.callbackSecret || '')
  const left = Buffer.from(provided)
  const right = Buffer.from(expected)
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right)
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })
  if (!(await rateLimit(req, 'truecaller-callback', 50))) return res.status(429).json({ error: 'rate_limited' })

  const body = jsonBody(req)
  if (!secretMatches(req, body)) return res.status(401).json({ error: 'unauthorized' })
  const nonce = String(body.requestId || body.requestNonce || '')
  if (nonce && body.status === 'flow_invoked') return res.status(202).json({ ok: true })
  const accessToken = String(body.accessToken || '')
  const endpoint = String(body.endpoint || body.endPoint || '')
  if (!nonce || !accessToken || !endpoint) return res.status(400).json({ error: 'invalid_payload' })
  if (!truecallerEndpointAllowed(endpoint)) return res.status(400).json({ error: 'bad_endpoint' })

  try {
    const pending = await readNonce(nonce)
    if (!pending) return res.status(404).json({ error: 'unknown_request' })
    if (pending.status === 'expired') return res.status(410).json({ error: 'expired' })
    if (pending.status === 'ready') return res.status(200).json({ ok: true })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    let profileResponse
    try {
      profileResponse = await fetch(endpoint, {
        redirect: 'error',
        signal: controller.signal,
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      })
    } finally {
      clearTimeout(timer)
    }
    if (!profileResponse.ok) {
      await markNonce(nonce, { status: 'error', error: `profile_fetch_${profileResponse.status}` })
      return res.status(502).json({ error: 'profile_fetch' })
    }
    const profile = await profileResponse.json()
    const phone = indianPhone(profile)
    if (!phone) {
      await markNonce(nonce, { status: 'error', error: 'unsupported_country' })
      return res.status(400).json({ error: 'unsupported_country' })
    }
    const session = await createFirebaseSession(phone, profile)
    const stored = await markNonce(nonce, { status: 'ready', ...session, error: null })
    return res.status(stored ? 200 : 409).json(stored ? { ok: true } : { error: 'not_storable' })
  } catch (error) {
    console.error('[truecaller/callback]', error?.message || error)
    await markNonce(nonce, { status: 'error', error: 'internal' }).catch(() => {})
    return res.status(500).json({ error: 'internal' })
  }
}
