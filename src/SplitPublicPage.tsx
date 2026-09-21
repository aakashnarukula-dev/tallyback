import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Check, LoaderCircle, Share2, ShieldCheck, UsersRound } from 'lucide-react'
import { SplitPage, SplitRecipient, subscribePublicSplit } from './firebase-splits'
import { money } from './currency'

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void }
  }
}

const apiBase = String(import.meta.env.VITE_API_BASE || '').replace(/\/$/, '')

async function loadRazorpay() {
  if (window.Razorpay) return true
  return new Promise<boolean>((resolve) => {
    const script = document.createElement('script')
    script.src = 'https://checkout.razorpay.com/v1/checkout.js'
    script.onload = () => resolve(true)
    script.onerror = () => resolve(false)
    document.head.appendChild(script)
  })
}

export default function SplitPublicPage({ splitId }: { splitId: string }) {
  const [page, setPage] = useState<SplitPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [payingId, setPayingId] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => subscribePublicSplit(splitId, (nextPage) => {
    setPage(nextPage)
    setLoading(false)
  }, () => {
    setError('This split could not be loaded.')
    setLoading(false)
  }), [splitId])

  const paidTotal = useMemo(() => page?.recipients.filter((row) => row.status === 'paid').reduce((sum, row) => sum + row.amount, 0) || 0, [page])
  const paidCount = page?.recipients.filter((row) => row.status === 'paid').length || 0
  const progress = page?.totalAmount ? Math.round((paidTotal / page.totalAmount) * 100) : 0

  async function share() {
    const data = { title: page?.title || 'TallyBack split', text: `Your share for ${page?.title || 'our expense'}`, url: window.location.href }
    const nativeShare = (navigator as unknown as { share?: (shareData: ShareData) => Promise<void> }).share
    try {
      if (nativeShare) await nativeShare.call(navigator, data)
      else await navigator.clipboard.writeText(window.location.href)
      setNotice(nativeShare ? 'Shared.' : 'Link copied.')
    } catch (shareError) {
      if ((shareError as Error).name !== 'AbortError') setNotice('Could not share this link.')
    }
  }

  async function pay(recipient: SplitRecipient) {
    if (!apiBase) {
      setNotice('Online payments are not configured yet. Ask the organizer to record your payment.')
      return
    }
    setPayingId(recipient.id)
    setNotice('')
    try {
      const response = await fetch(`${apiBase}/api/split-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ splitId, recipientId: recipient.id }),
      })
      const order = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(order.error || 'payment_unavailable')
      if (!(await loadRazorpay()) || !window.Razorpay) throw new Error('checkout_unavailable')

      const checkout = new window.Razorpay({
        key: order.keyId,
        amount: order.amount,
        currency: 'INR',
        name: page?.title || 'TallyBack split',
        description: `${recipient.name}'s share`,
        order_id: order.orderId,
        prefill: order.prefillContact ? { name: recipient.name, contact: order.prefillContact } : { name: recipient.name },
        theme: { color: '#5b5ce2' },
        handler: async (payment: Record<string, string>) => {
          try {
            setNotice('Confirming your payment…')
            const verify = await fetch(`${apiBase}/api/split-payment/verify`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...payment, splitId, recipientId: recipient.id }),
            })
            if (!verify.ok) throw new Error('verification_pending')
            setNotice('Payment confirmed. Your TallyBack balance is settled.')
          } catch {
            setNotice('Payment was received and is being confirmed. Please do not pay again.')
          } finally {
            setPayingId('')
          }
        },
        modal: { ondismiss: () => setPayingId('') },
      })
      checkout.open()
    } catch (paymentError) {
      const message = (paymentError as Error).message
      setNotice(message === 'already_paid' ? 'This share is already paid.' : 'Payment could not be opened. Please try again.')
      setPayingId('')
    }
  }

  if (loading) {
    return <main className="split-public-state"><LoaderCircle className="spin" size={25} /><strong>Opening shared expense…</strong></main>
  }

  if (error || !page || !page.active) {
    return (
      <main className="split-public-state">
        <div className="brand-mark" aria-hidden="true"><span /><span /></div>
        <h1>This split is unavailable.</h1>
        <p>{error || 'The organizer may have paused this payment link.'}</p>
        <a href="/"><ArrowLeft size={16} /> Open TallyBack</a>
      </main>
    )
  }

  return (
    <main className="split-public-page">
      <header className="split-public-header">
        <a className="brand" href="/"><div className="brand-mark" aria-hidden="true"><span /><span /></div><span>TallyBack</span></a>
        <button type="button" onClick={share}><Share2 size={17} /> Share</button>
      </header>

      <section className="split-public-hero">
        <p>Shared by {page.ownerName || 'a friend'}</p>
        <h1>{page.title}</h1>
        {page.description && <span>{page.description}</span>}
        <div className="split-progress-card">
          <div><span><UsersRound size={16} /> {paidCount} of {page.recipients.length} paid</span><strong>{money.format(paidTotal)} <small>of {money.format(page.totalAmount)}</small></strong></div>
          <div className="split-progress-track"><i style={{ width: `${progress}%` }} /></div>
        </div>
      </section>

      <section className="split-public-list" aria-label="People and shares">
        {page.recipients.map((recipient) => (
          <article className={recipient.status === 'paid' ? 'paid' : ''} key={recipient.id}>
            <div className="split-person-symbol">{recipient.status === 'paid' ? <Check size={18} /> : recipient.name.slice(0, 1).toUpperCase()}</div>
            <div><strong>{recipient.name}</strong><span>{recipient.status === 'paid' ? 'Payment complete' : 'Payment pending'}</span></div>
            <b>{money.format(recipient.amount)}</b>
            <button type="button" disabled={recipient.status === 'paid' || Boolean(payingId)} onClick={() => pay(recipient)}>
              {recipient.status === 'paid' ? 'Paid' : payingId === recipient.id ? 'Opening…' : 'Pay now'}
            </button>
          </article>
        ))}
      </section>

      {notice && <p className="split-public-notice" role="status">{notice}</p>}
      <p className="split-public-trust"><ShieldCheck size={16} /> Contact numbers are private. Payments are processed securely by Razorpay.</p>
    </main>
  )
}
