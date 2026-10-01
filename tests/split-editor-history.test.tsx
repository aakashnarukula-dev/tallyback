import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/firebase', () => ({ auth: { currentUser: { uid: 'owner' } } }))
vi.mock('../src/firebase-splits', async () => {
  const page = {
    id: 'kishore-wedding-gift', title: "Kishore's Wedding Gift", description: '', active: true, currency: 'INR',
    ownerUid: 'owner', ownerName: 'Aakash', recipients: [{ id: 'r1', name: 'Surya', amount: 100, status: 'pending' }], totalAmount: 100,
  }
  return {
    markSplitRecipientPaid: vi.fn(),
    newRecipient: () => ({ id: Math.random().toString(36), name: '', phone: '', amount: '', status: 'pending' }),
    saveSplitPage: vi.fn(),
    subscribeOwnedSplits: (_uid: string, onChange: (pages: unknown[]) => void) => { onChange([page]); return () => {} },
    subscribeSplitContacts: () => () => {},
  }
})

import SplitWorkspace from '../src/SplitWorkspace'

const owner = { name: 'Aakash', phone: '9177216132' }

async function goBack() {
  await act(async () => {
    window.history.back()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
}

afterEach(() => cleanup())

describe('split editor and browser back', () => {
  it('returns to the list after opening a split from it', async () => {
    window.history.replaceState(null, '', '/splits')
    render(<SplitWorkspace currentUser={owner} onNotice={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /Open Kishore/ }))
    expect(window.location.pathname).toBe('/splits/kishore-wedding-gift')
    expect(screen.getByText('Edit split')).toBeTruthy()
    await goBack()
    expect(window.location.pathname).toBe('/splits')
    await waitFor(() => expect(screen.queryByText('Edit split')).toBeNull())
  })

  it('returns to the list when the split was opened straight from its URL', async () => {
    // A fresh tab: whatever came before isn't the split list.
    window.history.pushState(null, '', '/dues')
    window.history.pushState(null, '', '/splits/kishore-wedding-gift')
    render(<SplitWorkspace currentUser={owner} onNotice={() => {}} />)
    expect(await screen.findByText('Edit split')).toBeTruthy()
    await goBack()
    expect(window.location.pathname).toBe('/splits')
    await waitFor(() => expect(screen.queryByText('Edit split')).toBeNull())
  })
})

describe('closing the split editor from the keyboard', () => {
  it('closes on Escape and on Backspace outside a text field, but not while typing', async () => {
    window.history.replaceState(null, '', '/splits')
    render(<SplitWorkspace currentUser={owner} onNotice={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /Open Kishore/ }))
    await userEvent.click(screen.getByDisplayValue("Kishore's Wedding Gift"))
    await userEvent.keyboard('{Backspace}')
    expect(screen.getByText('Edit split')).toBeTruthy()
    ;(document.activeElement as HTMLElement).blur()
    await userEvent.keyboard('{Backspace}')
    await waitFor(() => expect(screen.queryByText('Edit split')).toBeNull())
    expect(window.location.pathname).toBe('/splits')

    await userEvent.click(screen.getByRole('button', { name: /Open Kishore/ }))
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByText('Edit split')).toBeNull())
  })
})
