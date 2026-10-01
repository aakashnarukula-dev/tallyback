import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Check, LoaderCircle, Share2, ShieldCheck, UsersRound } from 'lucide-react'
import { SplitPage, subscribePublicSplit } from './firebase-splits'
import { money } from './currency'
import { buildUpiPaymentLink } from './upi'

export default function SplitPublicPage({ splitId }: { splitId: string }) {
  const [page, setPage] = useState<SplitPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
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
            {recipient.status === 'paid'
              ? <button type="button" disabled>Paid</button>
              : page.ownerUpiId
                ? <a className="split-public-pay" href={buildUpiPaymentLink({
                  upiId: page.ownerUpiId,
                  payeeName: page.ownerName,
                  amount: recipient.amount,
                  note: `TallyBack ${page.title}`,
                })}>Pay via UPI</a>
                : null}
          </article>
        ))}
      </section>

      {notice && <p className="split-public-notice" role="status">{notice}</p>}
      <p className="split-public-trust"><ShieldCheck size={16} /> Contact numbers are private. {page.ownerUpiId
        ? `Payments go straight to ${page.ownerName || 'the organizer'} over UPI with no fees. They mark your share paid once it arrives.`
        : `Pay ${page.ownerName || 'the organizer'} directly. They mark your share paid once it arrives.`}</p>
    </main>
  )
}
