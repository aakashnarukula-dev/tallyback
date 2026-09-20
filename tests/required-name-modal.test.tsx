import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasProfileName, RequiredNameModal } from '../src/App'

afterEach(() => {
  document.body.innerHTML = ''
  window.history.replaceState({}, '', '/')
})

describe('mandatory profile name', () => {
  it('rejects missing and fallback names', () => {
    expect(hasProfileName('')).toBe(false)
    expect(hasProfileName('   ')).toBe(false)
    expect(hasProfileName('TallyBack member')).toBe(false)
    expect(hasProfileName('My account')).toBe(false)
    expect(hasProfileName('Aakash')).toBe(true)
  })

  it('has no close controls and remains open on backdrop, Escape, and Back', () => {
    render(<RequiredNameModal onSave={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'What should we call you?' })
    expect(screen.queryByRole('button', { name: /close|cancel/i })).toBeNull()

    fireEvent.pointerDown(dialog.parentElement!)
    fireEvent.keyDown(window, { key: 'Escape' })
    window.dispatchEvent(new PopStateEvent('popstate'))

    expect(screen.getByRole('dialog', { name: 'What should we call you?' })).toBe(dialog)
    expect(window.history.state.tallyBackRequiredName).toBe(true)
  })

  it('keeps validation visible until valid name saves', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('Connection interrupted. Retry.')).mockResolvedValueOnce(undefined)
    const user = userEvent.setup()
    render(<RequiredNameModal onSave={save} />)
    const input = screen.getByRole('textbox', { name: 'Your name' })

    await user.type(input, 'Aakash')
    await user.click(screen.getByRole('button', { name: 'Save name' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Connection interrupted. Retry.')

    await user.click(screen.getByRole('button', { name: 'Save name' }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
  })
})
