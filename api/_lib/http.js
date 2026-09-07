const defaultOrigins = [
  'https://tally-back.web.app',
  'https://tally-back.firebaseapp.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]

function allowedOrigins() {
  return new Set([
    ...defaultOrigins,
    ...String(process.env.ALLOWED_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean),
  ])
}

export function allowCors(req, res) {
  const origin = String(req.headers.origin || '')
  if (allowedOrigins().has(origin)) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return true
  }
  return false
}

export function jsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body
  if (!req.body) return {}
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body)
  const type = String(req.headers['content-type'] || '')
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw))
  try { return JSON.parse(raw) } catch { return {} }
}
