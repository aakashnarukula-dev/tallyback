import { cert, getApp, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

let adminApp

export function getAdminApp() {
  if (adminApp) return adminApp
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY is not configured')
  const serviceAccount = JSON.parse(raw)
  adminApp = getApps().length ? getApp() : initializeApp({ credential: cert(serviceAccount) })
  return adminApp
}

export function adminDb() {
  return getFirestore(getAdminApp())
}

export function adminAuth() {
  return getAuth(getAdminApp())
}
