import { adminAuth, adminDb } from './firebase-admin.js'

export async function verifyActiveSession(idToken) {
  const decoded = await adminAuth().verifyIdToken(idToken, true)
  const session = await adminDb().collection('authSessions').doc(decoded.uid).get()
  if (session.exists && decoded.auth_time <= session.data().revokedBefore) {
    throw Object.assign(new Error('Session revoked'), { code: 'auth/id-token-revoked' })
  }
  return decoded
}
