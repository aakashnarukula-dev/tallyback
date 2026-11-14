import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ verify: vi.fn(), get: vi.fn(), doc: vi.fn() }))
vi.mock('../api/_lib/firebase-admin.js', () => ({
  adminAuth: () => ({ verifyIdToken: mocks.verify }),
  adminDb: () => ({ collection: () => ({ doc: mocks.doc }) }),
}))
import { verifyActiveSession } from '../api/_lib/auth-session.js'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.verify.mockResolvedValue({ uid: 'caller', auth_time: 100 })
  mocks.doc.mockReturnValue({ get: mocks.get })
  mocks.get.mockResolvedValue({ exists: false })
})
describe('server session validation', () => {
  it('checks Firebase revocation and accepts existing accounts without metadata', async () => {
    expect(await verifyActiveSession('token')).toEqual({ uid: 'caller', auth_time: 100 })
    expect(mocks.verify).toHaveBeenCalledWith('token', true)
    expect(mocks.doc).toHaveBeenCalledWith('caller')
  })
  it('rejects same-second cutoff and accepts only fresh authentication', async () => {
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ revokedBefore: 100 }) })
    await expect(verifyActiveSession('old')).rejects.toMatchObject({ code: 'auth/id-token-revoked' })
    mocks.verify.mockResolvedValue({ uid: 'caller', auth_time: 101 })
    await expect(verifyActiveSession('new')).resolves.toMatchObject({ uid: 'caller' })
  })
})
