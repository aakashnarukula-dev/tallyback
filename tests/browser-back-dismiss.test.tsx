import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useBrowserBackDismiss, useEscapeDismiss } from '../src/App'

function DismissLayer({ onDismiss }: { onDismiss: () => void }) {
  useBrowserBackDismiss(onDismiss)
  return <div>Open layer</div>
}

function EscapeLayer({ onDismiss, disabled = false }: { onDismiss: () => void; disabled?: boolean }) {
  useEscapeDismiss(onDismiss, disabled)
  return <div>Open dialog</div>
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.replaceState({}, '', '/')
})

describe('browser Back dismissal', () => {
  it('adds one same-page history entry in Strict Mode', () => {
    const pushState = vi.spyOn(window.history, 'pushState')

    render(
      <StrictMode>
        <DismissLayer onDismiss={vi.fn()} />
      </StrictMode>,
    )

    expect(pushState).toHaveBeenCalledTimes(1)
    expect(window.history.state.tallyBackDismissLayer).toMatch(/^tallyback-dismiss-layer-/)
  })

  it('dismisses the open layer when browser Back consumes its entry', () => {
    const onDismiss = vi.fn()
    render(<DismissLayer onDismiss={onDismiss} />)

    window.history.replaceState({}, '', '/')
    act(() => window.dispatchEvent(new PopStateEvent('popstate')))

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('dismisses only the top layer in a nested stack', () => {
    const dismissBottom = vi.fn()
    const dismissTop = vi.fn()
    vi.spyOn(window.history, 'back').mockImplementation(() => {})

    const bottom = render(<DismissLayer onDismiss={dismissBottom} />)
    const bottomState = window.history.state
    const top = render(<DismissLayer onDismiss={dismissTop} />)

    window.history.replaceState(bottomState, '', '/')
    act(() => window.dispatchEvent(new PopStateEvent('popstate')))

    expect(dismissBottom).not.toHaveBeenCalled()
    expect(dismissTop).toHaveBeenCalledTimes(1)

    top.unmount()
    bottom.unmount()
  })

  it('removes its history entry when closed from the UI', async () => {
    const goBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const view = render(<DismissLayer onDismiss={vi.fn()} />)

    view.unmount()
    await Promise.resolve()

    expect(goBack).toHaveBeenCalledTimes(1)
  })
})

describe('Escape dismissal', () => {
  it('dismisses an idle dialog', () => {
    const onDismiss = vi.fn()
    render(<EscapeLayer onDismiss={onDismiss} />)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('keeps a working dialog open', () => {
    const onDismiss = vi.fn()
    render(<EscapeLayer onDismiss={onDismiss} disabled />)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onDismiss).not.toHaveBeenCalled()
  })
})
