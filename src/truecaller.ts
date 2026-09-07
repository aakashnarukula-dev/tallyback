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

type AutomaticTruecallerOptions = {
  signal?: AbortSignal
  onLaunch?: () => void
  onFallback?: () => void
}

const apiBase = String(import.meta.env.VITE_API_BASE || '').replace(/\/$/, '')

const capabilityKey = 'tallyback_truecaller_capability_v1'

function abortError() {
  return new DOMException('Truecaller sign-in was cancelled.', 'AbortError')
}

function wait(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener('abort', cancel)
      resolve()
    }, milliseconds)
    const cancel = () => {
      window.clearTimeout(timeout)
      reject(abortError())
    }
    signal?.addEventListener('abort', cancel, { once: true })
  })
}

function isEmbeddedAndroidBrowser(userAgent: string) {
  return /\bwv\b|; wv\)|version\/\d+(?:\.\d+)* chrome\/\d+.*mobile safari\/\d+|fban|fbav|instagram|messenger/i.test(userAgent)
}

export function canAttemptAutomaticTruecaller() {
  const userAgent = navigator.userAgent || ''
  return /android/i.test(userAgent) && !isEmbeddedAndroidBrowser(userAgent)
}

function knownTruecallerDevice() {
  try {
    const savedAt = Number(window.localStorage.getItem(capabilityKey) || 0)
    return savedAt > Date.now() - 30 * 24 * 60 * 60 * 1000
  } catch {
    return false
  }
}

function rememberTruecallerDevice() {
  try {
    window.localStorage.setItem(capabilityKey, String(Date.now()))
  } catch {
    // Storage can be unavailable in privacy-focused browsers. The login still works.
  }
}

function fireDeeplink(deeplink: string) {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.display = 'none'
  frame.src = deeplink
  document.body.appendChild(frame)
  window.setTimeout(() => frame.remove(), 2_000)
}

function apiError(code?: string) {
  if (code === 'unsupported_country') return 'TallyBack currently supports Indian mobile numbers.'
  if (code === 'expired' || code === 'not_found') return 'The Truecaller request expired. Please try again.'
  if (code === 'rate_limited') return 'Too many sign-in attempts. Please wait a few minutes.'
  return 'Truecaller sign-in could not be completed. You can use SMS instead.'
}

export async function signInWithTruecaller({
  signal,
  onLaunch,
  onFallback,
}: AutomaticTruecallerOptions = {}): Promise<{ user: User; profile: TruecallerProfile } | null> {
  if (!auth) throw new Error('Firebase connection is not ready yet.')
  if (!apiBase) throw new Error('Truecaller sign-in is not configured yet. You can use SMS instead.')
  if (!canAttemptAutomaticTruecaller()) return null

  const initResponse = await fetch(`${apiBase}/api/truecaller/init`, { method: 'POST', signal })
  const init = await initResponse.json().catch(() => ({})) as { nonce?: string; deeplink?: string; error?: string }
  if (!initResponse.ok || !init.nonce || !init.deeplink) throw new Error(apiError(init.error))

  let appOpened = false
  let returnedAt = 0
  let fallbackShown = false
  const markOpened = () => {
    if (appOpened) return
    appOpened = true
    rememberTruecallerDevice()
    onLaunch?.()
  }
  const watchVisibility = () => {
    if (document.hidden || !document.hasFocus()) {
      markOpened()
    } else if (appOpened) {
      returnedAt = Date.now()
    }
  }

  document.addEventListener('visibilitychange', watchVisibility)
  window.addEventListener('blur', watchVisibility)
  window.addEventListener('focus', watchVisibility)
  window.addEventListener('pagehide', markOpened)
  fireDeeplink(init.deeplink)

  const detectionDeadline = Date.now() + (knownTruecallerDevice() ? 7_000 : 4_500)
  const deadline = Date.now() + 90_000

  try {
    while (Date.now() < deadline) {
      await wait(document.hidden ? 1_600 : 900, signal)
      const response = await fetch(`${apiBase}/api/truecaller/status?nonce=${encodeURIComponent(init.nonce)}`, { signal })
      const result = await response.json().catch(() => ({})) as TruecallerStatus

      if (result.status === 'ready' && result.customToken) {
        rememberTruecallerDevice()
        const credential = await signInWithCustomToken(auth, result.customToken)
        return { user: credential.user, profile: result.profile || {} }
      }
      if (result.status !== 'pending') throw new Error(apiError(result.error || result.status))

      if (!appOpened && Date.now() >= detectionDeadline) return null
      if (appOpened && returnedAt && !fallbackShown && Date.now() - returnedAt >= 2_500) {
        fallbackShown = true
        onFallback?.()
      }
    }
  } finally {
    document.removeEventListener('visibilitychange', watchVisibility)
    window.removeEventListener('blur', watchVisibility)
    window.removeEventListener('focus', watchVisibility)
    window.removeEventListener('pagehide', markOpened)
  }

  onFallback?.()
  return null
}
