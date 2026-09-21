import { describe, expect, it } from 'vitest'
import { money } from '../src/currency'

describe('INR formatting', () => {
  it('keeps paise while avoiding unnecessary trailing zeros', () => {
    expect(money.format(10)).toBe('₹10')
    expect(money.format(10.5)).toBe('₹10.5')
    expect(money.format(10.25)).toBe('₹10.25')
  })
})
