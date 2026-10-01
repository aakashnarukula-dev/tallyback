import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { splitEditorPath, splitIdFromEditorPath } from './routes'
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Link2,
  Plus,
  Save,
  Trash2,
} from 'lucide-react'
import { normalizePhone, Person } from './data'
import { money } from './currency'
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
import { SkeletonList } from './Skeleton'

// A split is the whole group's cost, so a new one starts with the owner's own
// share, already paid, and the people they are collecting from below it.
const blankDraft = (owner?: Person): SplitDraft => ({
  title: '',
  description: '',
  active: true,
  recipients: owner
    ? [{ ...newRecipient(), name: owner.name, phone: normalizePhone(owner.phone), status: 'paid' }, newRecipient()]
    : [newRecipient()],
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
  const [selectedId, setSelectedId] = useState(() => splitIdFromEditorPath(window.location.pathname))
  const [contacts, setContacts] = useState<Record<string, SplitContact>>({})
  const [draft, setDraft] = useState<SplitDraft>(blankDraft)
  const [creating, setCreating] = useState(false)
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

  // A split opened straight from its URL (new tab, typed link) has no list entry behind it,
  // so slot /splits in underneath; back, swipe and the editor's arrow then all land on the list.
  useEffect(() => {
    const path = window.location.pathname
    if (!splitIdFromEditorPath(path) || window.history.state?.tallyBackSplitEditor) return
    window.history.replaceState(null, '', splitEditorPath(''))
    window.history.pushState({ tallyBackSplitEditor: true }, '', path)
  }, [])

  // Back/forward between /splits and /splits/<slug> opens or closes the editor.
  useEffect(() => {
    const syncEditorWithUrl = () => {
      if (!window.location.pathname.toLowerCase().startsWith('/splits')) return
      const splitId = splitIdFromEditorPath(window.location.pathname)
      setCreating(false)
      setSelectedId(splitId)
      setContacts({})
      if (!splitId) setDraft(blankDraft())
    }
    window.addEventListener('popstate', syncEditorWithUrl)
    return () => window.removeEventListener('popstate', syncEditorWithUrl)
  }, [])

  // A /splits/<slug> link to a split this account doesn't own falls back to the list.
  useEffect(() => {
    if (loading || !selectedId || pages.some((page) => page.id === selectedId)) return
    if (splitIdFromEditorPath(window.location.pathname) !== selectedId) return
    if (window.history.state?.tallyBackSplitEditor) window.history.back()
    else window.history.replaceState(null, '', splitEditorPath(''))
    setSelectedId('')
    // Only checked once the list first loads; later saves add their page a moment after.
  }, [loading])

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

  // Escape, or Backspace outside a text field, closes the editor like the back arrow.
  const editorOpen = creating || Boolean(selectedId)
  useEffect(() => {
    if (!editorOpen) return
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      const typing = target?.closest('input, textarea, select, [contenteditable="true"]')
      if (event.key === 'Escape' || (event.key === 'Backspace' && !typing)) {
        event.preventDefault()
        closeEditorRef.current()
      }
    }
    window.addEventListener('keydown', closeOnKey)
    return () => window.removeEventListener('keydown', closeOnKey)
  }, [editorOpen])

  const ownerPhone = normalizePhone(currentUser.phone)
  const total = useMemo(() => draft.recipients.reduce((sum, row) => sum + (Number(row.amount) || 0), 0), [draft.recipients])
  const paid = useMemo(() => draft.recipients
    .filter((row) => row.status === 'paid' || (row.phone && normalizePhone(row.phone) === ownerPhone))
    .reduce((sum, row) => sum + Number(row.amount || 0), 0), [draft.recipients, ownerPhone])

  function showEditorUrl(splitId: string) {
    const path = splitEditorPath(splitId)
    if (window.location.pathname === path) return
    if (window.history.state?.tallyBackSplitEditor) window.history.replaceState({ tallyBackSplitEditor: true }, '', path)
    else window.history.pushState({ tallyBackSplitEditor: true }, '', path)
  }

  function selectPage(page: SplitPage) {
    showEditorUrl(page.id)
    setCreating(false)
    setSelectedId(page.id)
    setContacts({})
    setDraft(draftFromPage(page, {}))
  }

  function startNew() {
    // Give the new-split editor its own history entry so back closes it like an open split.
    if (!window.history.state?.tallyBackSplitEditor) window.history.pushState({ tallyBackSplitEditor: true }, '', splitEditorPath(''))
    setCreating(true)
    setSelectedId('')
    setContacts({})
    setDraft(blankDraft(currentUser))
  }

  function closeEditor() {
    // Step back to the list entry the editor was opened from.
    if (window.history.state?.tallyBackSplitEditor) window.history.back()
    else if (splitIdFromEditorPath(window.location.pathname)) window.history.replaceState(null, '', splitEditorPath(''))
    setCreating(false)
    setSelectedId('')
    setContacts({})
    setDraft(blankDraft())
  }

  const closeEditorRef = useRef(closeEditor)
  closeEditorRef.current = closeEditor

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
      showEditorUrl(id)
      setSelectedId(id)
      setCreating(false)
      onNotice('Split saved. Everyone with a number now has a matching ledger entry.')
    } catch (error) {
      onNotice((error as Error).message || 'Could not save this split.')
    } finally {
      setSaving(false)
    }
  }

  async function copyLink(splitId = selectedId) {
    if (!splitId) {
      onNotice('Save the split before copying its link.')
      return
    }
    const url = `${window.location.origin}/split/${splitId}`
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
      <div className={`split-admin-layout ${!pages.length ? 'single' : ''}`}>
        {pages.length > 0 ? (
          <aside className="split-list-panel">
            <div className="split-list-title"><strong>Your splits</strong><span>{pages.length}</span></div>
            <div className="split-card-list">
              {pages.map((page) => {
                const paidRows = page.recipients.filter((row) => row.status === 'paid')
                const paidAmount = paidRows.reduce((sum, row) => sum + row.amount, 0)
                const progress = page.totalAmount > 0 ? Math.min(100, Math.round((paidAmount / page.totalAmount) * 100)) : 0
                return (
                  <article key={page.id} className={`split-card ${selectedId === page.id ? 'active' : ''}`}>
                    <button type="button" className="split-card-open" onClick={() => selectPage(page)} aria-label={`Open ${page.title}`}>
                      <span className="split-card-head">
                        <strong>{page.title}</strong>
                        <em className={page.active ? 'live' : ''}>{page.active ? 'Live' : 'Paused'}</em>
                      </span>
                      <span className="split-card-amounts">
                        <span>{money.format(paidAmount)} <small>of {money.format(page.totalAmount)}</small></span>
                        <small>{paidRows.length} of {page.recipients.length} paid</small>
                      </span>
                      <span className="split-card-track" aria-hidden="true"><span style={{ width: `${progress}%` }} /></span>
                    </button>
                    <div className="split-card-actions">
                      <button type="button" onClick={() => copyLink(page.id)}><Copy size={14} /> Copy link</button>
                      <a href={`/split/${page.id}`} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Preview</a>
                    </div>
                  </article>
                )
              })}
            </div>
          </aside>
        ) : null}

        {loading ? (
          <SkeletonList variant="split" count={3} label="Loading splits" />
        ) : creating || selectedId ? (
        <form className="split-editor" onSubmit={save}>
          <header className="split-editor-bar">
            <div className="split-editor-title">
              <button className="split-editor-back" type="button" onClick={closeEditor} aria-label="Close split editor"><ArrowLeft size={20} /></button>
              <span><small>{creating ? 'New split' : 'Edit split'}</small><strong>{draft.title || 'Untitled split'}</strong></span>
            </div>
            <div className="split-editor-actions">
              <label className={`split-live-switch ${draft.active ? 'on' : ''}`} title={draft.active ? 'People can pay through the link' : 'The link is paused'}>
                <input type="checkbox" checked={draft.active} onChange={(event) => setDraft((current) => ({ ...current, active: event.target.checked }))} />
                <span className="split-live-switch-track" aria-hidden="true"><span /></span>
                <span>{draft.active ? 'Live' : 'Paused'}</span>
              </label>
              {selectedId ? (
                <>
                  <button className="split-icon-button" type="button" onClick={() => copyLink()} aria-label="Copy link" title="Copy link"><Copy size={16} /><span>Copy link</span></button>
                  <a className="split-icon-button" href={`/split/${selectedId}`} target="_blank" rel="noreferrer" aria-label="Preview" title="Preview"><ExternalLink size={16} /><span>Preview</span></a>
                </>
              ) : null}
              <button className="primary-button split-save-button" type="submit" disabled={saving}><Save size={16} /> {saving ? 'Saving…' : 'Save'}</button>
            </div>
          </header>

          <div className="split-form-card split-basics-card">
            <label>Split title<input required value={draft.title} maxLength={100} placeholder="Goa trip" onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} /></label>
            <label className="split-note-field">Short note<textarea value={draft.description} maxLength={280} placeholder="What is everyone contributing towards?" onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} /></label>
          </div>

          <div className="split-form-card">
            <div className="split-members-heading">
              <div><h2>People &amp; shares</h2><p>Phone numbers stay private.</p></div>
              <div><span>{money.format(paid)} collected</span><strong>{money.format(total)} total</strong></div>
            </div>

            <div className="split-people">
              {draft.recipients.map((row) => {
                const isYou = Boolean(row.phone) && normalizePhone(row.phone) === ownerPhone
                return (
                <div className="split-person" key={row.id}>
                  <input className="split-person-name" aria-label="Member name" required value={row.name} placeholder="Surya" onChange={(event) => updateRecipient(row.id, 'name', event.target.value)} />
                  <div className="split-member-phone"><span>+91</span><input aria-label="Member mobile number" inputMode="numeric" pattern="[0-9]{10}" value={row.phone.replace(/^\+91/, '')} placeholder="Add later" onChange={(event) => updateRecipient(row.id, 'phone', event.target.value.replace(/\D/g, '').slice(-10))} /></div>
                  <div className="split-member-amount"><span>₹</span><input aria-label="Share amount" required type="number" min="1" max="100000" step="0.01" value={row.amount || ''} placeholder="0" onChange={(event) => updateRecipient(row.id, 'amount', event.target.value)} /></div>
                  <div className="split-person-actions">
                    {isYou
                      ? <span className="split-paid-pill"><Check size={13} /> You · Paid</span>
                      : row.status === 'paid'
                      ? <span className="split-paid-pill"><Check size={13} /> Paid</span>
                      : selectedId
                        ? <button className="split-mark-button" type="button" onClick={() => markPaid(row.id)}><CheckCircle2 size={14} /> Mark as paid</button>
                        : <span className="split-pending-pill">Pending</span>}
                    {row.status !== 'paid' && !isYou && draft.recipients.length > 1 && (
                      <button className="split-remove-button" type="button" aria-label={`Remove ${row.name || 'member'}`} onClick={() => setDraft((current) => ({ ...current, recipients: current.recipients.filter((item) => item.id !== row.id) }))}><Trash2 size={15} /></button>
                    )}
                  </div>
                </div>
                )
              })}
            </div>
            <div className="split-add-row">
              <button className="split-add-member" type="button" onClick={() => setDraft((current) => ({ ...current, recipients: [...current.recipients, newRecipient()] }))}><Plus size={16} /> Add person</button>
              {/* Splits made before the owner was listed have no row for them. */}
              {!draft.recipients.some((row) => row.phone && normalizePhone(row.phone) === ownerPhone) && (
                <button className="split-add-member" type="button" onClick={() => setDraft((current) => ({ ...current, recipients: [{ ...newRecipient(), name: currentUser.name, phone: ownerPhone, status: 'paid' }, ...current.recipients] }))}><Plus size={16} /> Add your share</button>
              )}
            </div>
          </div>

          {selectedId && <p className="split-link-note"><Link2 size={15} /> tally-back.web.app/split/{selectedId}</p>}
        </form>
        ) : (
          <div className="split-launcher">
            <button className="split-launch-button" type="button" onClick={startNew}><Plus size={19} /> New split</button>
          </div>
        )}
      </div>
    </section>
  )
}
