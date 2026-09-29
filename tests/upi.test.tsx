import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RepaymentModal, UpiIdModal } from '../src/App'
import { LedgerEntry } from '../src/data'
import { buildUpiPaymentLink, isValidUpiId, normalizeUpiId } from '../src/upi'

const entry: LedgerEntry = {
  id: 'due-upi',
  lender: { name: 'Aakash', phone: '+919177216132' },
  borrower: { name: 'Friend', phone: '+919154195669' },
  amount: 1000,
  originalAmount: 1000,
  paidAmount: 400,
  remainingAmount: 600,
  occasion: 'Movie night',
  method: 'UPI',
  date: '2026-09-21',
  status: 'partially_paid',
  createdBy: 'lender-id',
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.replaceState({}, '', '/')
})

describe('UPI helpers', () => {
  it('accepts common UPI IDs and rejects malformed ones', () => {
    expect(isValidUpiId('aakash@okhdfcbank')).toBe(true)
    expect(isValidUpiId('9177216132@ybl')).toBe(true)
    expect(isValidUpiId('first.last-1@paytm')).toBe(true)
    expect(isValidUpiId(' aakash@upi ')).toBe(true)
    expect(isValidUpiId('aakash')).toBe(false)
    expect(isValidUpiId('a@b')).toBe(false)
    expect(isValidUpiId('aakash@1bank')).toBe(false)
    expect(isValidUpiId('aakash@@upi')).toBe(false)
    expect(isValidUpiId('aakash@upi?am=1')).toBe(false)
    expect(normalizeUpiId(' aakash @upi ')).toBe('aakash@upi')
  })

  it('builds a standard upi://pay link with encoded fields', () => {
    expect(buildUpiPaymentLink({ upiId: 'aakash@okhdfcbank', payeeName: 'Aakash N', amount: 600, note: 'TallyBack Movie night' }))
      .toBe('upi://pay?pa=aakash%40okhdfcbank&pn=Aakash%20N&am=600.00&cu=INR&tn=TallyBack%20Movie%20night')
  })

  it('leaves the amount open when none is given', () => {
    expect(buildUpiPaymentLink({ upiId: 'aakash@upi', payeeName: 'Aakash' }))
      .toBe('upi://pay?pa=aakash%40upi&pn=Aakash&cu=INR')
  })
})

describe('borrower UPI payment', () => {
  it('links to the lender UPI app flow with the typed amount', async () => {
    const user = userEvent.setup()
    render(<RepaymentModal entry={entry} mode="request" payeeUpiId="aakash@okhdfcbank" onClose={vi.fn()} onSend={vi.fn()} />)

    const payLink = screen.getByRole('link', { name: /Pay ₹600(\.00)? via UPI/ })
    expect(payLink.getAttribute('href')).toBe('upi://pay?pa=aakash%40okhdfcbank&pn=Aakash&am=600.00&cu=INR&tn=TallyBack%20Movie%20night')

    const amount = screen.getByRole('textbox', { name: /amount paid/i })
    await user.clear(amount)
    await user.type(amount, '250')
    expect(screen.getByRole('link', { name: /Pay ₹250(\.00)? via UPI/ }).getAttribute('href')).toContain('am=250.00')

    await user.clear(amount)
    await user.type(amount, '700')
    expect(screen.queryByRole('link', { name: /via UPI/ })).toBeNull()
    expect((screen.getByRole('button', { name: /Enter an amount to pay/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a scannable QR code and copies the UPI ID', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<RepaymentModal entry={entry} mode="request" payeeUpiId="aakash@okhdfcbank" onClose={vi.fn()} onSend={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /Show QR/ }))
    const qr = await screen.findByRole('img', { name: /UPI QR code to pay Aakash/ })
    expect(qr.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)

    await user.click(screen.getByRole('button', { name: 'Copy UPI ID aakash@okhdfcbank' }))
    expect(writeText).toHaveBeenCalledWith('aakash@okhdfcbank')
    await waitFor(() => expect(screen.getByText('Copied')).toBeTruthy())
  })

  it('explains when the lender has no UPI ID yet', () => {
    render(<RepaymentModal entry={entry} mode="request" payeeUpiId={null} onClose={vi.fn()} onSend={vi.fn()} />)
    expect(screen.getByText(/Aakash hasn't added a UPI ID yet/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /via UPI/ })).toBeNull()
  })

  it('is not shown when the lender records a payment', () => {
    render(<RepaymentModal entry={entry} mode="record" payeeUpiId="aakash@okhdfcbank" onClose={vi.fn()} onSend={vi.fn()} />)
    expect(screen.queryByText(/Pay Aakash directly/)).toBeNull()
  })
})

describe('UPI ID editor', () => {
  it('validates and saves a trimmed UPI ID', async () => {
    vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<UpiIdModal currentUpiId={null} onClose={onClose} onSave={onSave} />)

    const input = screen.getByRole('textbox', { name: 'UPI ID' })
    await user.type(input, 'aakash')
    await user.click(screen.getByRole('button', { name: 'Save UPI ID' }))
    expect(screen.getByRole('alert').textContent).toContain('name@okhdfcbank')
    expect(onSave).not.toHaveBeenCalled()

    await user.type(input, '@okhdfcbank ')
    await user.click(screen.getByRole('button', { name: 'Save UPI ID' }))
    expect(onSave).toHaveBeenCalledWith('aakash@okhdfcbank')
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('removes an existing UPI ID', async () => {
    vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<UpiIdModal currentUpiId="aakash@upi" onClose={vi.fn()} onSave={onSave} />)

    expect((screen.getByRole('textbox', { name: 'UPI ID' }) as HTMLInputElement).value).toBe('aakash@upi')
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onSave).toHaveBeenCalledWith(null)
  })
})
