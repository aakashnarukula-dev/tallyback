import crypto from 'node:crypto'
import { FieldValue } from 'firebase-admin/firestore'
import { adminAuth, adminDb } from './firebase-admin.js'

const collection = 'truecallerAuth'
const ttlMs = 10 * 60 * 1000

export function createNonce() {
  return crypto.randomBytes(18).toString('base64url')
}

export function truecallerDeeplink(nonce) {
  const key = process.env.TRUECALLER_PARTNER_KEY
  if (!key) throw new Error('TRUECALLER_PARTNER_KEY is not configured')
  const params = new URLSearchParams({
    requestNonce: nonce,
    partnerKey: key,
    partnerName: process.env.TRUECALLER_PARTNER_NAME || 'TallyBack',
    lang: 'en',
    title: 'signIn',
  })
  return `truecallersdk://truesdk/web_verify?${params}`
}

export async function storePendingNonce(nonce) {
  await adminDb().collection(collection).doc(nonce).set({
    status: 'pending',
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: new Date(Date.now() + ttlMs),
  })
}

export async function readNonce(nonce) {
  const ref = adminDb().collection(collection).doc(nonce)
  const snapshot = await ref.get()
  if (!snapshot.exists) return null
  const data = snapshot.data() || {}
  const expiresAt = data.expiresAt?.toDate?.() || data.expiresAt
  if (!(expiresAt instanceof Date) || expiresAt.getTime() < Date.now()) {
    await ref.delete().catch(() => {})
    return { status: 'expired' }
  }
  return data
}

export async function markNonce(nonce, patch) {
  const ref = adminDb().collection(collection).doc(nonce)
  return adminDb().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref)
    if (!snapshot.exists || !['pending', 'error'].includes(snapshot.data()?.status)) return false
    transaction.set(ref, patch, { merge: true })
    return true
  })
}

export async function consumeReadyNonce(nonce) {
  const ref = adminDb().collection(collection).doc(nonce)
  return adminDb().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref)
    if (!snapshot.exists) return { status: 'not_found' }
    const data = snapshot.data() || {}
    const expiresAt = data.expiresAt?.toDate?.() || data.expiresAt
    if (!(expiresAt instanceof Date) || expiresAt.getTime() < Date.now()) {
      transaction.delete(ref)
      return { status: 'expired' }
    }
    if (data.status !== 'ready' || !data.customToken) return { status: data.status || 'pending', error: data.error }
    transaction.delete(ref)
    return { status: 'ready', customToken: data.customToken, profile: data.profile || {} }
  })
}

export function truecallerEndpointAllowed(endpoint) {
  try {
    const url = new URL(endpoint)
    const host = url.hostname.toLowerCase()
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && (!url.port || url.port === '443')
      && (host === 'truecaller.com' || host.endsWith('.truecaller.com'))
  } catch {
    return false
  }
}

function profileName(profile) {
  if (typeof profile?.name === 'string') return profile.name.trim()
  return [profile?.name?.first || profile?.firstName, profile?.name?.last || profile?.lastName].filter(Boolean).join(' ').trim()
}

function profileEmail(profile) {
  return profile?.onlineIdentities?.email || profile?.email || undefined
}

export function indianPhone(profile) {
  const raw = Array.isArray(profile?.phoneNumbers) ? profile.phoneNumbers[0] : ''
  const digits = String(raw || '').replace(/\D/g, '')
  return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : null
}

export async function createFirebaseSession(phone, profile) {
  const phoneNumber = `+91${phone}`
  const name = profileName(profile) || 'TallyBack member'
  const email = profileEmail(profile)
  let user
  try {
    user = await adminAuth().getUserByPhoneNumber(phoneNumber)
    if (!user.displayName && name !== 'TallyBack member') {
      user = await adminAuth().updateUser(user.uid, { displayName: name })
    }
  } catch (error) {
    if (error?.code !== 'auth/user-not-found') throw error
    user = await adminAuth().createUser({ phoneNumber, displayName: name, ...(email ? { email } : {}) })
  }

  const userRef = adminDb().collection('users').doc(user.uid)
  const existing = await userRef.get()
  const savedName = existing.data()?.name || name
  await userRef.set({ name: savedName, phone: phoneNumber, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  const sessionClaims = {
    ...(user.customClaims || {}),
    loginMethod: 'truecaller',
    verifiedPhone: phoneNumber,
  }
  await adminAuth().setCustomUserClaims(user.uid, sessionClaims)
  const customToken = await adminAuth().createCustomToken(user.uid, sessionClaims)
  return { customToken, profile: { phone, name: savedName, email: email || null } }
}
