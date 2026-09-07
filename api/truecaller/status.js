import { allowCors } from '../_lib/http.js'
import { consumeReadyNonce, readNonce } from '../_lib/truecaller.js'

export default async function handler(req, res) {
  if (allowCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })
  const nonce = String(req.query?.nonce || '')
  if (!nonce) return res.status(400).json({ error: 'missing_nonce' })
  try {
    const data = await readNonce(nonce)
    if (!data) return res.status(404).json({ status: 'not_found' })
    if (data.status === 'ready') return res.status(200).json(await consumeReadyNonce(nonce))
    return res.status(data.status === 'expired' ? 410 : 200).json({ status: data.status, ...(data.error ? { error: data.error } : {}) })
  } catch (error) {
    console.error('[truecaller/status]', error?.message || error)
    return res.status(500).json({ error: 'internal' })
  }
}
