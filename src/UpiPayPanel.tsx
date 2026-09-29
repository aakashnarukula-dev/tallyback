import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, LoaderCircle, QrCode, Smartphone } from 'lucide-react'
import { money } from './currency'
import { buildUpiPaymentLink } from './upi'

function prefersQrCode() {
  try {
    return window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? false
  } catch {
    return false
  }
}

export function UpiPayPanel({
  upiId,
  payeeName,
  amount,
  note,
}: {
  // undefined while the payee's UPI ID is loading, null when they have not added one.
  upiId: string | null | undefined
  payeeName: string
  amount: number
  note?: string
}) {
  const [showQr, setShowQr] = useState(prefersQrCode)
  const [qrUrl, setQrUrl] = useState('')
  const [copied, setCopied] = useState(false)
  const payable = Number.isFinite(amount) && amount > 0
  const link = useMemo(
    () => upiId ? buildUpiPaymentLink({ upiId, payeeName, amount: payable ? amount : undefined, note }) : '',
    [upiId, payeeName, amount, payable, note],
  )

  useEffect(() => {
    if (!showQr || !link) return
    let cancelled = false
    import('qrcode')
      .then(({ toString }) => toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }))
      .then((svg) => { if (!cancelled) setQrUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`) })
      .catch(() => { if (!cancelled) setQrUrl('') })
    return () => { cancelled = true }
  }, [showQr, link])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(timer)
  }, [copied])

  async function copyUpiId() {
    if (!upiId) return
    try {
      await navigator.clipboard.writeText(upiId)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  if (upiId === undefined) {
    return (
      <section className="upi-pay-panel upi-pay-muted" aria-live="polite">
        <LoaderCircle className="spin" size={16} /> Checking {payeeName}&apos;s UPI ID…
      </section>
    )
  }

  if (!upiId) {
    return (
      <section className="upi-pay-panel upi-pay-muted">
        <Smartphone size={16} />
        <span>{payeeName} hasn&apos;t added a UPI ID yet. Pay them in any UPI app, then record it below.</span>
      </section>
    )
  }

  return (
    <section className="upi-pay-panel" aria-labelledby="upi-pay-title">
      <div className="upi-pay-heading">
        <strong id="upi-pay-title">Pay {payeeName} directly</strong>
        <span>UPI · no fees</span>
      </div>
      {payable ? (
        <a className="primary-button upi-pay-button" href={link}>
          <Smartphone size={16} /> Pay {money.format(amount)} via UPI
        </a>
      ) : (
        <button className="primary-button upi-pay-button" type="button" disabled>
          <Smartphone size={16} /> Enter an amount to pay
        </button>
      )}
      <div className="upi-pay-tools">
        <button type="button" className="upi-pay-copy" onClick={copyUpiId} aria-label={`Copy UPI ID ${upiId}`}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
          <span>{copied ? 'Copied' : upiId}</span>
        </button>
        <button type="button" className="upi-pay-qr-toggle" onClick={() => setShowQr((open) => !open)} aria-expanded={showQr}>
          <QrCode size={14} /> {showQr ? 'Hide QR' : 'Show QR'}
        </button>
      </div>
      {showQr ? (
        <div className="upi-pay-qr">
          {qrUrl
            ? <img src={qrUrl} alt={`UPI QR code to pay ${payeeName}${payable ? ` ${money.format(amount)}` : ''}`} />
            : <LoaderCircle className="spin" size={20} />}
          <small>Scan with any UPI app</small>
        </div>
      ) : null}
      <p className="upi-pay-hint">After paying, add the UPI screenshot below and send it for approval.</p>
    </section>
  )
}
