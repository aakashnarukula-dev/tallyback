import { FormEvent, useEffect, useMemo, useState } from 'react'
import {
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Link2,
  Plus,
  Save,
  Trash2,
} from 'lucide-react'
import { Person } from './data'
import {
  markSplitRecipientPaid,
  newRecipient,
  saveSplitPage,
  SplitContact,
  SplitDraft,
  SplitPage,
  subscribeOwnedSplits,
  subscribeSplitContacts,
} from './firebase-splits'
import { auth } from './firebase'

const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
})

const blankDraft = (): SplitDraft => ({
  title: '',
  description: '',
  active: true,
  recipients: [newRecipient()],
})

function draftFromPage(page: SplitPage, contacts: Record<string, SplitContact>): SplitDraft {
  return {
    id: page.id,
    title: page.title,
    description: page.description || '',
    active: page.active,
    recipients: page.recipients.map((row) => ({
      ...row,
      phone: contacts[row.id]?.phone || '',
    })),
  }
}

export default function SplitWorkspace({ currentUser, onNotice }: { currentUser: Person; onNotice: (message: string) => void }) {
  const [pages, setPages] = useState<SplitPage[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [contacts, setContacts] = useState<Record<string, SplitContact>>({})
  const [draft, setDraft] = useState<SplitDraft>(blankDraft)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!auth?.currentUser) return
    return subscribeOwnedSplits(auth.currentUser.uid, (nextPages) => {
      setPages(nextPages)
      setLoading(false)
    }, () => {
      setLoading(false)
      onNotice('Could not load your split payments.')
    })
  }, [onNotice])

  useEffect(() => {
    if (!selectedId) {
      setContacts({})
      return
    }
    return subscribeSplitContacts(selectedId, setContacts, () => onNotice('Could not load private contact numbers.'))
  }, [onNotice, selectedId])

  useEffect(() => {
    if (!selectedId) return
    const page = pages.find((item) => item.id === selectedId)
    if (page) setDraft(draftFromPage(page, contacts))
  }, [contacts, pages, selectedId])

  const total = useMemo(() => draft.recipients.reduce((sum, row) => sum + (Number(row.amount) || 0), 0), [draft.recipients])
  const paid = useMemo(() => draft.recipients.filter((row) => row.status === 'paid').reduce((sum, row) => sum + Number(row.amount || 0), 0), [draft.recipients])

  function selectPage(page: SplitPage) {
    setSelectedId(page.id)
    setContacts({})
    setDraft(draftFromPage(page, {}))
  }

  function startNew() {
    setSelectedId('')
    setContacts({})
    setDraft(blankDraft())
  }

  function updateRecipient(id: string, key: 'name' | 'phone' | 'amount', value: string) {
    setDraft((current) => ({
      ...current,
      recipients: current.recipients.map((row) => row.id === id
        ? { ...row, [key]: key === 'amount' ? value : value }
        : row),
    }))
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!auth?.currentUser) return
    setSaving(true)
    try {
      const id = await saveSplitPage(draft, auth.currentUser.uid, currentUser)
      setSelectedId(id)
      onNotice('Split saved. Every member now has a matching ledger entry.')
    } catch (error) {
      onNotice((error as Error).message || 'Could not save this split.')
    } finally {
      setSaving(false)
    }
  }

  async function copyLink() {
    if (!selectedId) {
      onNotice('Save the split before copying its link.')
      return
    }
    const url = `${window.location.origin}/split/${selectedId}`
    try {
      await navigator.clipboard.writeText(url)
      onNotice('Public payment link copied.')
    } catch {
      onNotice(url)
    }
  }

  async function markPaid(recipientId: string) {
    if (!selectedId || !auth?.currentUser) return
    try {
      await markSplitRecipientPaid(selectedId, recipientId, auth.currentUser.uid)
      onNotice('Payment recorded and the linked loan was settled.')
    } catch (error) {
      onNotice((error as Error).message || 'Could not record this payment.')
    }
  }

  return (
    <section className="split-workspace">
      <div className={`split-admin-layout ${!loading && !pages.length ? 'single' : ''}`}>
        {(loading || pages.length > 0) ? (
          <aside className="split-list-panel">
            <div className="split-list-title"><strong>Your splits</strong><span>{pages.length}</span></div>
            <div className="split-list">
              {pages.map((page) => {
                const paidCount = page.recipients.filter((row) => row.status === 'paid').length
                return (
                  <button type="button" key={page.id} className={selectedId === page.id ? 'active' : ''} onClick={() => selectPage(page)}>
                    <span><strong>{page.title}</strong><small>{paidCount}/{page.recipients.length} paid</small></span>
                    <em className={page.active ? 'live' : ''}>{page.active ? 'Live' : 'Paused'}</em>
                  </button>
                )
              })}
              {loading ? <div className="split-list-empty"><p>Loading splits…</p></div> : null}
            </div>
          </aside>
        ) : null}

        <form className="split-editor" onSubmit={save}>
          <div className="split-editor-bar">
            <div><strong>{draft.title || 'Untitled split'}</strong></div>
            <div>
              {selectedId ? <button className="secondary-button" type="button" onClick={copyLink}><Copy size={15} /> Copy link</button> : null}
              {selectedId && <a className="secondary-button" href={`/split/${selectedId}`} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Preview</a>}
              <button className="primary-button" type="submit" disabled={saving}><Save size={15} /> {saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>

          <div className="split-form-card split-basics-card">
            <label>Split title<input required value={draft.title} maxLength={100} placeholder="Goa trip" onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} /></label>
            <label className="split-live-toggle">
              <input type="checkbox" checked={draft.active} onChange={(event) => setDraft((current) => ({ ...current, active: event.target.checked }))} />
              <span><strong>{draft.active ? 'Payment link is live' : 'Payment link is paused'}</strong></span>
            </label>
            <label className="split-note-field">Short note<textarea value={draft.description} maxLength={280} placeholder="What is everyone contributing towards?" onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} /></label>
          </div>

          <div className="split-form-card">
            <div className="split-members-heading">
              <div><h2>People &amp; shares</h2><p>Phone numbers stay private.</p></div>
              <div><span>{money.format(paid)} collected</span><strong>{money.format(total)} total</strong></div>
            </div>

            <div className="split-member-labels"><span>Name</span><span>Mobile number</span><span>Share</span><span>Status</span></div>
            <div className="split-members">
              {draft.recipients.map((row) => (
                <div className="split-member-row" key={row.id}>
                  <input aria-label="Member name" required value={row.name} placeholder="Surya" onChange={(event) => updateRecipient(row.id, 'name', event.target.value)} />
                  <div className="split-member-phone"><span>+91</span><input aria-label="Member mobile number" required inputMode="numeric" value={row.phone.replace(/^\+91/, '')} placeholder="98765 43210" onChange={(event) => updateRecipient(row.id, 'phone', event.target.value.replace(/\D/g, '').slice(-10))} /></div>
                  <div className="split-member-amount"><span>₹</span><input aria-label="Share amount" required type="number" min="1" max="100000" step="0.01" value={row.amount || ''} placeholder="0" onChange={(event) => updateRecipient(row.id, 'amount', event.target.value)} /></div>
                  <div className="split-member-actions">
                    {row.status === 'paid'
                      ? <span className="split-paid-pill"><Check size={13} /> Paid</span>
                      : selectedId
                        ? <button className="split-mark-button" type="button" onClick={() => markPaid(row.id)}><CheckCircle2 size={14} /> Mark paid</button>
                        : <span className="split-pending-pill">Pending</span>}
                    {row.status !== 'paid' && draft.recipients.length > 1 && (
                      <button className="split-remove-button" type="button" aria-label={`Remove ${row.name || 'member'}`} onClick={() => setDraft((current) => ({ ...current, recipients: current.recipients.filter((item) => item.id !== row.id) }))}><Trash2 size={15} /></button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <button className="split-add-member" type="button" onClick={() => setDraft((current) => ({ ...current, recipients: [...current.recipients, newRecipient()] }))}><Plus size={16} /> Add person</button>
          </div>

          {selectedId && <p className="split-link-note"><Link2 size={15} /> tally-back.web.app/split/{selectedId}</p>}
        </form>
      </div>

      <button className="add-person-fab" type="button" onClick={startNew}><Plus size={18} /> <span>New split</span></button>
    </section>
  )
}
