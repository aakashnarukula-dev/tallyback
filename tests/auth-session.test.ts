import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auth, User } from 'firebase/auth'
import type { Firestore } from 'firebase/firestore'

const mocks = vi.hoisted(() => ({
  onAuthStateChanged: vi.fn(), signOut: vi.fn(), onSnapshot: vi.fn(), doc: vi.fn(),
  auth: { currentUser: null as unknown },
}))
vi.mock('firebase/auth', () => ({ onAuthStateChanged: mocks.onAuthStateChanged, signOut: mocks.signOut }))
vi.mock('firebase/firestore', () => ({ onSnapshot: mocks.onSnapshot, doc: mocks.doc }))
vi.mock('../src/firebase', () => ({ auth: mocks.auth }))
vi.stubEnv('VITE_API_BASE', 'https://api.example.com')
const { monitorAuthSessions, signOutAllDevices } = await import('../src/auth-session')

function session(authTime = 100) {
  return { uid: 'owner', getIdTokenResult: vi.fn().mockResolvedValue({ claims: { auth_time: authTime } }), getIdToken: vi.fn().mockResolvedValue('owner-token') } as unknown as User
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.currentUser = null
  mocks.onAuthStateChanged.mockReturnValue(vi.fn())
  mocks.onSnapshot.mockReturnValue(vi.fn())
  mocks.signOut.mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllGlobals())

describe('live session sign-out', () => {
  it('signs out both devices immediately, including sessions from the cutoff second', async () => {
    const devices = [session(99), session(100)].map((user) => ({ currentUser: user } as Auth))
    const cleanups = devices.map((device) => monitorAuthSessions(device, {} as Firestore))
    mocks.onAuthStateChanged.mock.calls.forEach(([, callback], index) => callback(devices[index].currentUser))
    await flush()
    const callbacks = mocks.onSnapshot.mock.calls.map(([, callback]) => callback)
    callbacks.forEach((callback) => callback({ data: () => undefined }))
    expect(mocks.signOut).not.toHaveBeenCalled()
    callbacks.forEach((callback) => callback({ data: () => ({ revokedBefore: 100 }) }))
    expect(mocks.signOut.mock.calls.map(([auth]) => auth)).toEqual(devices)
    cleanups.forEach((cleanup) => cleanup())
  })

  it('keeps fresh login valid and ignores old listener after account change', async () => {
    const oldUser = session(101)
    const device = { currentUser: oldUser } as Auth
    const cleanup = monitorAuthSessions(device, {} as Firestore)
    const callback = mocks.onAuthStateChanged.mock.calls[0][1]
    callback(oldUser)
    await flush()
    const update = mocks.onSnapshot.mock.calls[0][1]
    update({ data: () => ({ revokedBefore: 100 }) })
    expect(mocks.signOut).not.toHaveBeenCalled()
    const stopSnapshot = mocks.onSnapshot.mock.results[0].value
    Object.assign(device, { currentUser: session(102) })
    callback(device.currentUser)
    update({ data: () => ({ revokedBefore: 200 }) })
    expect(stopSnapshot).toHaveBeenCalledOnce()
    expect(mocks.signOut).not.toHaveBeenCalled()
    cleanup()
    await flush()
    expect(mocks.onSnapshot).toHaveBeenCalledOnce()
  })

  it('checks existing cutoff on reopened sessions without requiring a new event', async () => {
    const user = session(99)
    const device = { currentUser: user } as Auth
    const cleanup = monitorAuthSessions(device, {} as Firestore)
    mocks.onAuthStateChanged.mock.calls[0][1](user)
    await flush()
    mocks.onSnapshot.mock.calls[0][1]({ data: () => ({ revokedBefore: 100 }) })
    expect(mocks.signOut).toHaveBeenCalledWith(device)
    cleanup()
  })
})

describe('all-device sign-out request', () => {
  it('uses caller token and POST with no target UID supplied by client', async () => {
    mocks.auth.currentUser = session()
    const fetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetch)
    await signOutAllDevices()
    expect(fetch).toHaveBeenCalledWith('https://api.example.com/api/auth/signout-all', {
      method: 'POST', headers: { Authorization: 'Bearer owner-token' },
    })
  })

  it('surfaces failure without reporting success', async () => {
    mocks.auth.currentUser = session()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    await expect(signOutAllDevices()).rejects.toThrow('Could not sign out all devices')
  })
})
