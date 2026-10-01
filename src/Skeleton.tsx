type SkeletonVariant = 'person' | 'activity' | 'split'

export function SkeletonBar({ width, height = 10 }: { width: number | string; height?: number }) {
  return <span className="skeleton-bar" style={{ width, height }} aria-hidden="true" />
}

const NAME_WIDTHS = ['42%', '30%', '36%', '26%', '34%']
const AMOUNT_WIDTHS = [74, 62, 58, 52, 66]

export function SkeletonList({ variant, count = 5, label }: { variant: SkeletonVariant; count?: number; label: string }) {
  return (
    <div className={`skeleton-list skeleton-${variant}-list`} role="status" aria-live="polite" aria-busy="true">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: count }, (_, index) => {
        const nameWidth = NAME_WIDTHS[index % NAME_WIDTHS.length]
        const amountWidth = AMOUNT_WIDTHS[index % AMOUNT_WIDTHS.length]
        if (variant === 'person') {
          return (
            <article className="contact-ledger-card skeleton-card" key={index} aria-hidden="true">
              <div className="contact-ledger-main">
                <span className="avatar avatar-md skeleton-circle" />
                <span className="contact-ledger-copy">
                  <SkeletonBar width={nameWidth} height={13} />
                  <SkeletonBar width={86} height={9} />
                </span>
                <span className="contact-ledger-amount">
                  <SkeletonBar width={amountWidth} height={14} />
                  <SkeletonBar width={38} height={9} />
                </span>
              </div>
            </article>
          )
        }
        if (variant === 'activity') {
          return (
            <article className="activity-row skeleton-card" key={index} aria-hidden="true">
              <span className="skeleton-block" />
              <div className="skeleton-copy">
                <SkeletonBar width={nameWidth} height={12} />
                <SkeletonBar width="58%" height={9} />
              </div>
              <div className="activity-amount">
                <SkeletonBar width={amountWidth} height={13} />
                <SkeletonBar width={44} height={9} />
              </div>
            </article>
          )
        }
        return (
          <article className="skeleton-split-card skeleton-card" key={index} aria-hidden="true">
            <span className="skeleton-split-head">
              <SkeletonBar width={nameWidth} height={13} />
              <SkeletonBar width={38} height={16} />
            </span>
            <span className="skeleton-split-head">
              <SkeletonBar width={amountWidth + 40} height={11} />
              <SkeletonBar width={60} height={9} />
            </span>
            <SkeletonBar width="100%" height={5} />
          </article>
        )
      })}
    </div>
  )
}
