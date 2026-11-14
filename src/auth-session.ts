import { type Auth, onAuthStateChanged, signOut, type User } from 'firebase/auth'
import { doc, type Firestore, onSnapshot } from 'firebase/firestore'
import { auth } from './firebase'

const apiBase = String(import.meta.env.VITE_API_BASE || '').replace(/\/$/, '')

export async function signOutAllDevices() {
  const user = auth?.currentUser
  if (!user) throw new Error('Sign in again before signing out all devices.')
  if (!apiBase) throw new Error('Sign-out service is not configured.')
  const token = await user.getIdToken()
  const response = await fetch(`${apiBase}/api/auth/signout-all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    throw new Error(response.status === 401
      ? 'Session expired. Sign in again.'
      : 'Could not sign out all devices. Check your connection and retry.')
  }
}

// Runs outside the authenticated workspace so public split routes are covered too.
export function monitorAuthSessions(currentAuth: Auth, firestore: Firestore) {
  let stopSnapshot: (() => void) | undefined
  let generation = 0
  let stopped = false

  async function watch(user: User, version: number) {
    try {
      const token = await user.getIdTokenResult()
      if (stopped || version !== generation || currentAuth.currentUser !== user) return
      const authTime = Number(token.claims.auth_time)
      let signingOut = false
      stopSnapshot = onSnapshot(doc(firestore, 'authSessions', user.uid), (snapshot) => {
        if (stopped || version !== generation || currentAuth.currentUser !== user || signingOut) return
        const cutoff = snapshot.data()?.revokedBefore
        if (typeof cutoff !== 'number' || authTime > cutoff) return
        signingOut = true
        void signOut(currentAuth).catch((error) => {
          signingOut = false
          console.error('[auth/session-signout]', error)
        })
      }, (error) => {
        console.error('[auth/session-listener]', error)
      })
    } catch (error) {
      if (stopped || version !== generation || currentAuth.currentUser !== user) return
      const code = (error as { code?: string }).code
      if (code === 'auth/user-token-expired' || code === 'auth/invalid-user-token' || code === 'auth/user-disabled') {
        await signOut(currentAuth)
      } else {
        console.error('[auth/session-token]', error)
      }
    }
  }

  const stopAuth = onAuthStateChanged(currentAuth, (user) => {
    generation += 1
    stopSnapshot?.()
    stopSnapshot = undefined
    if (user) void watch(user, generation)
  })
  return () => {
    stopped = true
    generation += 1
    stopAuth()
    stopSnapshot?.()
  }
}
