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
  prepared?: TruecallerInit
  signal?: AbortSignal
  onLaunch?: () => void
  onFallback?: () => void
}

export type TruecallerInit = {
  nonce: string
  deeplink: string
  preparedAt: number
}

const apiBase = String(import.meta.env.VITE_API_BASE || '').replace(/\/$/, '')

const capabilityKey = 'tallyback_truecaller_capability_v1'
const prewarmTtlMs = 9 * 60 * 1000

let prewarmedTruecaller: TruecallerInit | null = null
let prewarmRequest: Promise<TruecallerInit | null> | null = null

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
  frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden;'
  frame.src = deeplink
  document.body.appendChild(frame)
  window.setTimeout(() => frame.remove(), 200)
}

function apiError(code?: string) {
  if (code === 'unsupported_country') return 'TallyBack currently supports Indian mobile numbers.'
  if (code === 'expired' || code === 'not_found') return 'The Truecaller request expired. Please try again.'
  if (code === 'rate_limited') return 'Too many sign-in attempts. Please wait a few minutes.'
  return 'Truecaller sign-in could not be completed. You can use SMS instead.'
}

export function prepareTruecaller(): Promise<TruecallerInit | null> {
  if (!apiBase || !canAttemptAutomaticTruecaller()) return Promise.resolve(null)
  if (prewarmedTruecaller && Date.now() - prewarmedTruecaller.preparedAt < prewarmTtlMs) {
    return Promise.resolve(prewarmedTruecaller)
  }
  if (prewarmRequest) return prewarmRequest

  prewarmRequest = fetch(`${apiBase}/api/truecaller/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).then(async (response) => {
    const result = await response.json().catch(() => ({})) as { nonce?: string; deeplink?: string }
    if (!response.ok || !result.nonce || !result.deeplink) return null
    prewarmedTruecaller = {
      nonce: result.nonce,
      deeplink: result.deeplink,
      preparedAt: Date.now(),
    }
    return prewarmedTruecaller
  }).catch(() => null).finally(() => {
    prewarmRequest = null
  })

  return prewarmRequest
}

export async function signInWithTruecaller({
  prepared,
  signal,
  onLaunch,
  onFallback,
}: AutomaticTruecallerOptions = {}): Promise<{ user: User; profile: TruecallerProfile } | null> {
  if (!auth) throw new Error('Firebase connection is not ready yet.')
  if (!apiBase) throw new Error('Truecaller sign-in is not configured yet. You can use SMS instead.')
  if (!canAttemptAutomaticTruecaller()) return null

  const init = prepared || await prepareTruecaller()
  if (!init) throw new Error(apiError())
  if (prewarmedTruecaller?.nonce === init.nonce) prewarmedTruecaller = null

  let appOpened = false
  let fallbackShown = false
  let returnTimer: number | null = null
  const markOpened = () => {
    if (appOpened) return
    appOpened = true
    if (returnTimer) window.clearTimeout(returnTimer)
    rememberTruecallerDevice()
    onLaunch?.()
  }
  const watchVisibility = () => {
    if (document.hidden || !document.hasFocus()) {
      markOpened()
    } else if (appOpened && !fallbackShown && !returnTimer) {
      returnTimer = window.setTimeout(() => {
        fallbackShown = true
        onFallback?.()
      }, 250)
    }
  }

  document.addEventListener('visibilitychange', watchVisibility)
  window.addEventListener('blur', watchVisibility)
  window.addEventListener('focus', watchVisibility)
  window.addEventListener('pagehide', markOpened)
  const focusTimer = window.setInterval(watchVisibility, 200)
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
    }
  } finally {
    window.clearInterval(focusTimer)
    if (returnTimer) window.clearTimeout(returnTimer)
    document.removeEventListener('visibilitychange', watchVisibility)
    window.removeEventListener('blur', watchVisibility)
    window.removeEventListener('focus', watchVisibility)
    window.removeEventListener('pagehide', markOpened)
  }

  onFallback?.()
  return null
}

if (typeof window !== 'undefined' && canAttemptAutomaticTruecaller()) {
  void prepareTruecaller()
}
