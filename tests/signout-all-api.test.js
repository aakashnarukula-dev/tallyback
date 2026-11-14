import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ verify: vi.fn(), revoke: vi.fn(), getUser: vi.fn(), transaction: vi.fn(), doc: vi.fn() }))
vi.mock('../api/_lib/auth-session.js', () => ({ verifyActiveSession: mocks.verify }))
vi.mock('../api/_lib/firebase-admin.js', () => ({
  adminAuth: () => ({ revokeRefreshTokens: mocks.revoke, getUser: mocks.getUser }),
  adminDb: () => ({ collection: () => ({ doc: mocks.doc }), runTransaction: mocks.transaction }),
}))
import handler from '../api/auth/signout-all.js'

function response() {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn(), end: vi.fn() }
  res.status.mockReturnValue(res)
  return res
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.verify.mockResolvedValue({ uid: 'caller' })
  mocks.revoke.mockResolvedValue(undefined)
  mocks.getUser.mockResolvedValue({ tokensValidAfterTime: '2026-11-14T00:00:00.000Z' })
  mocks.doc.mockReturnValue('caller-ref')
  mocks.transaction.mockImplementation(async (callback) => callback({ get: vi.fn().mockResolvedValue({ data: () => undefined }), set: vi.fn() }))
})

describe('sign-out all devices API', () => {
  it('revokes only verified caller and publishes cutoff after revocation', async () => {
    const res = response()
    const set = vi.fn()
    mocks.transaction.mockImplementation(async (callback) => callback({ get: vi.fn().mockResolvedValue({ data: () => ({ revokedBefore: 2000000000 }) }), set }))
    await handler({ method: 'POST', headers: { authorization: 'Bearer valid' }, body: { uid: 'victim' } }, res)
    expect(mocks.verify).toHaveBeenCalledWith('valid')
    expect(mocks.revoke).toHaveBeenCalledWith('caller')
    expect(mocks.doc).toHaveBeenCalledWith('caller')
    expect(set).toHaveBeenCalledWith('caller-ref', { revokedBefore: 2000000000 })
    expect(mocks.revoke.mock.invocationCallOrder[0]).toBeLessThan(mocks.transaction.mock.invocationCallOrder[0])
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('rejects missing and revoked tokens before any revocation', async () => {
    const missing = response()
    await handler({ method: 'POST', headers: {} }, missing)
    expect(missing.status).toHaveBeenCalledWith(401)
    mocks.verify.mockRejectedValue(Object.assign(new Error('Revoked'), { code: 'auth/id-token-revoked' }))
    const revoked = response()
    await handler({ method: 'POST', headers: { authorization: 'Bearer old' } }, revoked)
    expect(revoked.status).toHaveBeenCalledWith(401)
    expect(mocks.revoke).not.toHaveBeenCalled()
  })

  it('does not return success when live broadcast fails', async () => {
    mocks.transaction.mockRejectedValue(new Error('Firestore unavailable'))
    const res = response()
    await handler({ method: 'POST', headers: { authorization: 'Bearer valid' } }, res)
    expect(res.status).toHaveBeenCalledWith(503)
  })

  it('handles preflight and disallows GET', async () => {
    const preflight = response()
    await handler({ method: 'OPTIONS', headers: { origin: 'https://tally-back.web.app' } }, preflight)
    expect(preflight.status).toHaveBeenCalledWith(204)
    expect(preflight.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'https://tally-back.web.app')
    const get = response()
    await handler({ method: 'GET', headers: {} }, get)
    expect(get.status).toHaveBeenCalledWith(405)
    expect(mocks.verify).not.toHaveBeenCalled()
  })
})
