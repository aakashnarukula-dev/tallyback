import { describe, expect, it } from 'vitest'
import { viewFromPath } from '../src/App'
import { splitEditorPath, splitIdFromEditorPath } from '../src/routes'

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

describe('split editor paths', () => {
  it('keeps /splits/<slug> on the Splits section', () => {
    expect(viewFromPath('/splits/kishore-wedding-gift')).toBe('splits')
    expect(splitIdFromEditorPath('/splits/kishore-wedding-gift')).toBe('kishore-wedding-gift')
    expect(splitEditorPath('kishore-wedding-gift')).toBe('/splits/kishore-wedding-gift')
    expect(splitEditorPath('')).toBe('/splits')
  })

  it('leaves the public /split/<slug> page alone', () => {
    expect(splitIdFromEditorPath('/split/kishore-wedding-gift')).toBe('')
    expect(splitIdFromEditorPath('/splits')).toBe('')
  })
})
