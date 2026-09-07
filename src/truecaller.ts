import { signInWithCustomToken, User } from 'firebase/auth'
import { auth } from './firebase'

type TruecallerProfile = {
  phone?: string
  name?: string | null
  email?: string | null
}

type TruecallerStatus = {
  status?: 'pending' | 'ready' | 'error' | 'expired' | 'not_found'
  customToken?: string
  profile?: TruecallerProfile
  error?: string
}

const apiBase = String(import.meta.env.VITE_API_BASE || '').replace(/\/$/, '')

const delay = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds))

function apiError(code?: string) {
  if (code === 'unsupported_country') return 'TallyBack currently supports Indian mobile numbers.'
  if (code === 'expired' || code === 'not_found') return 'The Truecaller request expired. Please try again.'
  if (code === 'rate_limited') return 'Too many sign-in attempts. Please wait a few minutes.'
  return 'Truecaller sign-in could not be completed. You can use SMS instead.'
}

export async function signInWithTruecaller(): Promise<{ user: User; profile: TruecallerProfile }> {
  if (!auth) throw new Error('Firebase connection is not ready yet.')
  if (!apiBase) throw new Error('Truecaller sign-in is not configured yet. You can use SMS instead.')

  const initResponse = await fetch(`${apiBase}/api/truecaller/init`, { method: 'POST' })
  const init = await initResponse.json().catch(() => ({})) as { nonce?: string; deeplink?: string; error?: string }
  if (!initResponse.ok || !init.nonce || !init.deeplink) throw new Error(apiError(init.error))

  window.location.href = init.deeplink
  const deadline = Date.now() + 90_000

  while (Date.now() < deadline) {
    await delay(document.hidden ? 1_600 : 900)
    const response = await fetch(`${apiBase}/api/truecaller/status?nonce=${encodeURIComponent(init.nonce)}`)
    const result = await response.json().catch(() => ({})) as TruecallerStatus

    if (result.status === 'pending') continue
    if (result.status === 'ready' && result.customToken) {
      const credential = await signInWithCustomToken(auth, result.customToken)
      return { user: credential.user, profile: result.profile || {} }
    }
    throw new Error(apiError(result.error || result.status))
  }

  throw new Error('Truecaller did not respond. Please try again or use SMS.')
}
