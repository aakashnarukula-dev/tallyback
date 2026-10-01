import { describe, expect, it } from 'vitest'
import { viewFromPath } from '../src/App'

describe('viewFromPath', () => {
  it('opens the section named in the URL', () => {
    expect(viewFromPath('/dues')).toBe('ledger')
    expect(viewFromPath('/splits')).toBe('splits')
    expect(viewFromPath('/activity/')).toBe('activity')
  })

  it('falls back to Dues for the root and unknown paths', () => {
    expect(viewFromPath('/')).toBe('ledger')
    expect(viewFromPath('/something-else')).toBe('ledger')
  })
})
