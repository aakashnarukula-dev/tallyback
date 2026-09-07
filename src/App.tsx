import { FormEvent, useEffect, useMemo, useState } from 'react'
import {
  ConfirmationResult,
  onAuthStateChanged,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  signOut as signOutOfFirebase,
} from 'firebase/auth'
import {
  ArrowDownLeft,
  ArrowUpRight,
  BadgeCheck,
  Banknote,
  Bell,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  CreditCard,
  History,
  Landmark,
  LogOut,
  MoreHorizontal,
  Plus,
  ReceiptText,
  Search,
  ShieldCheck,
  Split,
  Smartphone,
  Sparkles,
  UsersRound,
  WalletCards,
  X,
} from 'lucide-react'
import {
  avatarColor,
  initials,
  LedgerEntry,
  normalizePhone,
  PaymentMethod,
  Person,
} from './data'
import { auth, isFirebaseConfigured } from './firebase'
import {
  createEntry as createFirebaseEntry,
  getUserProfile,
  saveUserProfile,
  settleEntry as settleFirebaseEntry,
  subscribeToEntries,
  toE164,
} from './firebase-ledger'
import { signInWithTruecaller } from './truecaller'
import SplitPublicPage from './SplitPublicPage'
import SplitWorkspace from './SplitWorkspace'

type Direction = 'receivable' | 'payable'
type View = 'ledger' | 'activity' | 'splits'

type ContactSummary = {
  person: Person
  total: number
  openCount: number
  latestDate: string
  entries: LedgerEntry[]
}

const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
})

const shortDate = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

const methodIcons: Record<PaymentMethod, typeof CreditCard> = {
  UPI: Smartphone,
  'Credit card': CreditCard,
  Cash: Banknote,
  'Bank transfer': Landmark,
  'Personal funds': WalletCards,
}

const methods: PaymentMethod[] = [
  'UPI',
  'Credit card',
  'Cash',
  'Bank transfer',
  'Personal funds',
]

const today = () => new Date().toISOString().slice(0, 10)

function Avatar({ person, size = 'md' }: { person: Person; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span
      className={`avatar avatar-${size}`}
      style={{ backgroundColor: avatarColor(person.phone) }}
      aria-hidden="true"
    >
      {initials(person.name)}
    </span>
  )
}

function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <span />
      <span />
    </div>
  )
}

function formatPhone(phone: string) {
  const clean = normalizePhone(phone)
  return clean.length === 10 ? `+91 ${clean.slice(0, 5)} ${clean.slice(5)}` : phone
}

let recaptchaVerifier: RecaptchaVerifier | null = null

function authErrorMessage(error: unknown) {
  const code = (error as { code?: string }).code
  if (code === 'auth/invalid-verification-code') return 'That code is incorrect. Check the SMS and try again.'
  if (code === 'auth/too-many-requests') return 'Too many attempts. Wait a little before trying again.'
  if (code === 'auth/invalid-phone-number') return 'Enter a valid mobile number.'
  if (code === 'auth/quota-exceeded') return 'The SMS limit has been reached. Try again later.'
  if (code === 'auth/operation-not-allowed') return 'Phone sign-in still needs to be enabled in Firebase.'
  return 'Could not complete sign-in. Check your connection and try again.'
}

function LoginScreen({
  onAuthenticated,
}: {
  onAuthenticated: (person: Person) => void
}) {
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [confirmation, setConfirmation] = useState<ConfirmationResult | null>(null)
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  const [truecallerWorking, setTruecallerWorking] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')

    if (confirmation) {
      if (code.length !== 6) {
        setError('Enter the 6-digit code from the SMS.')
        return
      }

      try {
        setWorking(true)
        const credential = await confirmation.confirm(code)
        const existingProfile = await getUserProfile(credential.user.uid)
        const person = {
          name: existingProfile?.name || credential.user.displayName || 'TallyBack member',
          phone: credential.user.phoneNumber ?? toE164(phone),
        }
        await saveUserProfile(credential.user.uid, person)
        onAuthenticated(person)
      } catch (verificationError) {
        setError(authErrorMessage(verificationError))
      } finally {
        setWorking(false)
      }
      return
    }

    if (normalizePhone(phone).length !== 10) {
      setError('Enter a valid 10-digit mobile number.')
      return
    }

    if (!auth || !isFirebaseConfigured) {
      setError('Firebase connection is not ready yet.')
      return
    }

    try {
      setWorking(true)
      recaptchaVerifier?.clear()
      recaptchaVerifier = new RecaptchaVerifier(auth, 'phone-sign-in-button', {
        size: 'invisible',
      })
      const result = await signInWithPhoneNumber(auth, toE164(phone), recaptchaVerifier)
      setConfirmation(result)
    } catch (signInError) {
      recaptchaVerifier?.clear()
      recaptchaVerifier = null
      setError(authErrorMessage(signInError))
    } finally {
      setWorking(false)
    }
  }

  async function continueWithTruecaller() {
    setError('')
    if (!auth || !isFirebaseConfigured) {
      setError('Firebase connection is not ready yet.')
      return
    }
    if (!/android/i.test(navigator.userAgent || '')) {
      setError('Truecaller one-tap works on Android. Use your mobile number below on this device.')
      return
    }

    try {
      setTruecallerWorking(true)
      const result = await signInWithTruecaller()
      const person = {
        name: result.profile.name || result.user.displayName || 'TallyBack member',
        phone: result.user.phoneNumber || toE164(result.profile.phone || ''),
      }
      await saveUserProfile(result.user.uid, person)
      onAuthenticated(person)
    } catch (truecallerError) {
      setError((truecallerError as Error).message || 'Truecaller sign-in could not be completed.')
    } finally {
      setTruecallerWorking(false)
    }
  }

  function changeNumber() {
    setConfirmation(null)
    setCode('')
    setError('')
    recaptchaVerifier?.clear()
    recaptchaVerifier = null
  }

  return (
    <main className="login-page">
      <section className="login-story">
        <a className="brand brand-on-dark" href="#" aria-label="TallyBack home">
          <BrandMark />
          <span>TallyBack</span>
        </a>
        <div className="login-story-copy">
          <p className="story-kicker">Money between friends, made clear.</p>
          <h1>Every shared expense. One clear story.</h1>
          <div className="story-note">
            <div className="story-note-top">
              <Avatar person={{ name: 'Surya', phone: '9988776655' }} />
              <span>Surya owes you</span>
              <strong>{money.format(18450)}</strong>
            </div>
            <div className="story-line">
              <span>Flight tickets to Goa</span>
              <span>{money.format(8200)}</span>
            </div>
            <div className="story-line">
              <span>Dinner at Burma Burma</span>
              <span>{money.format(2450)}</span>
            </div>
            <div className="story-line">
              <span>Rent advance</span>
              <span>{money.format(7800)}</span>
            </div>
          </div>
        </div>
        <p className="login-trust"><ShieldCheck size={17} /> Only people on a loan can view it.</p>
      </section>

      <section className="login-form-panel">
        <form className="login-form" onSubmit={submit}>
          <div className="mobile-brand">
            <BrandMark />
            <span>TallyBack</span>
          </div>
          <p className="login-step">{confirmation ? 'Check your messages' : 'Welcome'}</p>
          <h2>{confirmation ? 'Enter your code.' : 'Your money, remembered.'}</h2>
          <p className="login-subtitle">
            {confirmation
              ? `We sent a 6-digit verification code to +91 ${phone.slice(0, 5)} ${phone.slice(5)}.`
              : 'Use the mobile number your friends know. Your shared entries will be waiting for you.'}
          </p>
          {!confirmation && (
            <>
              <button
                className="truecaller-button"
                type="button"
                onClick={continueWithTruecaller}
                disabled={truecallerWorking || working}
              >
                <BadgeCheck size={19} />
                {truecallerWorking ? 'Opening Truecaller…' : 'Continue with Truecaller'}
              </button>
              <div className="login-divider"><span>or use SMS</span></div>
            </>
          )}
          {confirmation ? (
            <label>
              Verification code
              <div className="input-shell verification-input">
                <ShieldCheck size={18} />
                <input
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                  placeholder="000000"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                />
              </div>
            </label>
          ) : (
            <label>
              Mobile number
              <div className="phone-input">
                <span>+91</span>
                <input
                  value={phone}
                  onChange={(event) => setPhone(event.target.value.replace(/[^0-9]/g, '').slice(0, 10))}
                  placeholder="98765 43210"
                  inputMode="numeric"
                  autoComplete="tel"
                />
              </div>
            </label>
          )}
          {error && <p className="form-error">{error}</p>}
          <button
            id="phone-sign-in-button"
            className="primary-button login-button"
            type="submit"
            disabled={working}
          >
            {working ? 'Please wait…' : confirmation ? 'Verify and continue' : 'Text me a code'}
          </button>
          {confirmation && <button className="demo-login" type="button" onClick={changeNumber}>Use a different number</button>}
          <p className="login-fine-print">
            Truecaller verifies your number without an OTP on supported Android devices. SMS is available as a secure fallback.
          </p>
          <div id="recaptcha-container" />
        </form>
      </section>
    </main>
  )
}

function AddEntryModal({
  initialDirection,
  currentUser,
  onClose,
  onSave,
}: {
  initialDirection: Direction
  currentUser: Person
  onClose: () => void
  onSave: (entry: LedgerEntry) => void
}) {
  const [direction, setDirection] = useState(initialDirection)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [amount, setAmount] = useState('')
  const [occasion, setOccasion] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('UPI')
  const [date, setDate] = useState(today())
  const [error, setError] = useState('')

  function submit(event: FormEvent) {
    event.preventDefault()
    const numericAmount = Number(amount)
    if (!name.trim() || normalizePhone(phone).length !== 10) {
      setError('Add a name and valid 10-digit mobile number.')
      return
    }
    if (!numericAmount || numericAmount <= 0 || !occasion.trim()) {
      setError('Add the amount and what it was for.')
      return
    }

    const other = { name: name.trim(), phone: normalizePhone(phone) }
    onSave({
      id: `loan-${Date.now()}`,
      lender: direction === 'receivable' ? currentUser : other,
      borrower: direction === 'receivable' ? other : currentUser,
      amount: numericAmount,
      occasion: occasion.trim(),
      method,
      date,
      status: 'open',
    })
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-entry-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <p className="modal-kicker">New entry</p>
            <h2 id="add-entry-title">Who paid?</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={submit}>
          <div className="direction-picker" aria-label="Choose who paid">
            <button
              type="button"
              className={direction === 'receivable' ? 'active' : ''}
              onClick={() => setDirection('receivable')}
            >
              <ArrowDownLeft size={18} />
              <span><strong>I paid</strong><small>They owe me</small></span>
              {direction === 'receivable' && <Check size={17} />}
            </button>
            <button
              type="button"
              className={direction === 'payable' ? 'active' : ''}
              onClick={() => setDirection('payable')}
            >
              <ArrowUpRight size={18} />
              <span><strong>They paid</strong><small>I owe them</small></span>
              {direction === 'payable' && <Check size={17} />}
            </button>
          </div>

          <div className="form-grid">
            <label>
              {direction === 'receivable' ? 'Who owes you?' : 'Who do you owe?'}
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name" autoFocus />
            </label>
            <label>
              Mobile number
              <div className="phone-input compact">
                <span>+91</span>
                <input
                  value={phone}
                  onChange={(event) => setPhone(event.target.value.replace(/[^0-9]/g, '').slice(0, 10))}
                  placeholder="98765 43210"
                  inputMode="numeric"
                />
              </div>
            </label>
            <label className="amount-field">
              Amount
              <div className="money-input">
                <span>₹</span>
                <input
                  value={amount}
                  onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))}
                  placeholder="0"
                  inputMode="decimal"
                />
              </div>
            </label>
            <label>
              What was it for?
              <input value={occasion} onChange={(event) => setOccasion(event.target.value)} placeholder="Dinner, tickets, rent…" />
            </label>
            <label>
              Paid using
              <select value={method} onChange={(event) => setMethod(event.target.value as PaymentMethod)}>
                {methods.map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
            <label>
              Date
              <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            </label>
          </div>
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
            <button className="primary-button" type="submit">Save entry</button>
          </div>
        </form>
      </section>
    </div>
  )
}

function PersonDrawer({
  summary,
  direction,
  onClose,
  onSettle,
}: {
  summary: ContactSummary
  direction: Direction
  onClose: () => void
  onSettle: (id: string) => void
}) {
  return (
    <div className="drawer-backdrop" onMouseDown={onClose} role="presentation">
      <aside className="person-drawer" onMouseDown={(event) => event.stopPropagation()}>
        <div className="drawer-topbar">
          <button className="drawer-back" onClick={onClose} aria-label="Close details"><ChevronLeft size={20} /></button>
          <span>Details</span>
          <button className="icon-button" aria-label="More options"><MoreHorizontal size={20} /></button>
        </div>
        <div className="person-hero">
          <Avatar person={summary.person} size="lg" />
          <h2>{summary.person.name}</h2>
          <p>{formatPhone(summary.person.phone)}</p>
          <strong className={direction === 'payable' ? 'amount-negative' : ''}>{money.format(summary.total)}</strong>
          <span>{direction === 'receivable' ? 'owes you' : 'you owe'}</span>
        </div>
        <div className="drawer-divider" />
        <div className="drawer-entries">
          <div className="drawer-section-title">
            <h3>Open entries</h3>
            <span>{summary.openCount}</span>
          </div>
          {summary.entries.filter((entry) => entry.status === 'open').map((entry) => {
            const Icon = methodIcons[entry.method]
            return (
              <article className="drawer-entry" key={entry.id}>
                <span className="method-icon"><Icon size={17} /></span>
                <div>
                  <h4>{entry.occasion}</h4>
                  <p>{entry.method} · {shortDate.format(new Date(`${entry.date}T00:00:00`))}</p>
                </div>
                <strong>{money.format(entry.amount)}</strong>
                <button onClick={() => onSettle(entry.id)}><CheckCircle2 size={16} /> Mark paid</button>
              </article>
            )
          })}
        </div>
        <p className="drawer-note">
          <ShieldCheck size={16} /> This record is visible only to you and {summary.person.name}.
        </p>
      </aside>
    </div>
  )
}

function TallyBackApp() {
  const [currentUser, setCurrentUser] = useState<Person | null>(null)
  const [entries, setEntries] = useState<LedgerEntry[]>([])
  const [authLoading, setAuthLoading] = useState(isFirebaseConfigured)
  const [dataLoading, setDataLoading] = useState(false)
  const [direction, setDirection] = useState<Direction>('receivable')
  const [view, setView] = useState<View>('ledger')
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null)
  const [toast, setToast] = useState('')
  const [profileOpen, setProfileOpen] = useState(false)

  useEffect(() => {
    if (!auth) {
      setAuthLoading(false)
      return
    }

    return onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser) {
        setCurrentUser(null)
        setAuthLoading(false)
        return
      }

      try {
        const profile = await getUserProfile(firebaseUser.uid)
        setCurrentUser(profile ?? {
          name: 'My account',
          phone: firebaseUser.phoneNumber ?? '',
        })
      } catch {
        setCurrentUser({
          name: 'My account',
          phone: firebaseUser.phoneNumber ?? '',
        })
      } finally {
        setAuthLoading(false)
      }
    })
  }, [])

  useEffect(() => {
    if (!currentUser) {
      setEntries([])
      return
    }

    if (!auth?.currentUser || !isFirebaseConfigured) return

    setDataLoading(true)
    return subscribeToEntries(
      currentUser.phone,
      (cloudEntries) => {
        setEntries(cloudEntries)
        setDataLoading(false)
      },
      () => {
        setDataLoading(false)
        setToast('Could not sync your ledger. Check the Firebase setup and try again.')
      },
    )
  }, [currentUser])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2800)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowAdd(false)
        setSelectedPhone(null)
        setProfileOpen(false)
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [])

  const userPhone = normalizePhone(currentUser?.phone ?? '')
  const relevantEntries = useMemo(() => {
    if (!currentUser) return []
    return entries.filter((entry) =>
      direction === 'receivable'
        ? normalizePhone(entry.lender.phone) === userPhone
        : normalizePhone(entry.borrower.phone) === userPhone,
    )
  }, [currentUser, direction, entries, userPhone])

  const summaries = useMemo(() => {
    const grouped = new Map<string, ContactSummary>()
    relevantEntries.forEach((entry) => {
      const person = direction === 'receivable' ? entry.borrower : entry.lender
      const key = normalizePhone(person.phone)
      const existing = grouped.get(key) ?? {
        person,
        total: 0,
        openCount: 0,
        latestDate: entry.date,
        entries: [],
      }
      existing.entries.push(entry)
      if (entry.status === 'open') {
        existing.total += entry.amount
        existing.openCount += 1
      }
      if (entry.date > existing.latestDate) existing.latestDate = entry.date
      grouped.set(key, existing)
    })
    return [...grouped.values()]
      .filter((summary) => summary.openCount > 0)
      .filter((summary) => summary.person.name.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => b.total - a.total)
  }, [direction, relevantEntries, search])

  const total = summaries.reduce((sum, item) => sum + item.total, 0)
  const openEntries = summaries.reduce((sum, item) => sum + item.openCount, 0)
  const selectedSummary = summaries.find((item) => normalizePhone(item.person.phone) === selectedPhone)

  const methodTotals = useMemo(() => {
    const totals = new Map<PaymentMethod, number>()
    relevantEntries.filter((entry) => entry.status === 'open').forEach((entry) => {
      totals.set(entry.method, (totals.get(entry.method) ?? 0) + entry.amount)
    })
    return [...totals.entries()].sort((a, b) => b[1] - a[1])
  }, [relevantEntries])

  const recentEntries = useMemo(
    () => [...relevantEntries].sort((a, b) => b.date.localeCompare(a.date)),
    [relevantEntries],
  )

  function loginToFirebase(person: Person) {
    setCurrentUser(person)
  }

  async function logout() {
    if (auth) await signOutOfFirebase(auth)
    setCurrentUser(null)
    setEntries([])
    setProfileOpen(false)
  }

  async function saveEntry(entry: LedgerEntry) {
    try {
      if (auth?.currentUser) {
        await createFirebaseEntry(entry, auth.currentUser.uid)
      } else {
        throw new Error('Sign in required')
      }
      setDirection(normalizePhone(entry.lender.phone) === userPhone ? 'receivable' : 'payable')
      setView('ledger')
      setShowAdd(false)
      setToast('Entry saved. Both sides now share the same record.')
    } catch {
      setToast('Could not save this entry. Please try again.')
    }
  }

  async function markEntrySettled(id: string) {
    try {
      await settleFirebaseEntry(id)
      setSelectedPhone(null)
      setToast('Marked as paid.')
    } catch {
      setToast('Could not update this entry. Please try again.')
    }
  }

  if (authLoading) {
    return (
      <main className="auth-loading" aria-label="Loading TallyBack">
        <BrandMark />
        <strong>TallyBack</strong>
        <span>Opening your ledger…</span>
      </main>
    )
  }

  if (!currentUser) {
    return <LoginScreen onAuthenticated={loginToFirebase} />
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" aria-label="TallyBack home">
          <BrandMark />
          <span>TallyBack</span>
        </a>
        <nav className="side-nav" aria-label="Primary navigation">
          <button className={view === 'ledger' ? 'active' : ''} onClick={() => setView('ledger')}>
            <ReceiptText size={19} /> My ledger
          </button>
          <button className={view === 'activity' ? 'active' : ''} onClick={() => setView('activity')}>
            <History size={19} /> Activity
          </button>
          <button className={view === 'splits' ? 'active' : ''} onClick={() => setView('splits')}>
            <Split size={19} /> Split payments
          </button>
        </nav>
        <div className="sidebar-card">
          <Sparkles size={18} />
          <p><strong>Keep it clear</strong>Add every payment when it happens. Everyone sees the same total.</p>
        </div>
        <p className="sidebar-foot">Synced securely with Firebase</p>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="mobile-logo"><BrandMark /><span>TallyBack</span></div>
          <div className="topbar-actions">
            <button className="icon-button notification-button" aria-label="Notifications">
              <Bell size={19} />
              <span />
            </button>
            <div className="profile-wrap">
              <button
                className="profile-button"
                onClick={() => setProfileOpen((open) => !open)}
                aria-label={`Open profile menu for ${currentUser.name}`}
                aria-expanded={profileOpen}
              >
                <Avatar person={currentUser} size="sm" />
                <span>{currentUser.name}</span>
                <ChevronDown size={15} />
              </button>
              {profileOpen && (
                <div className="profile-menu">
                  <div><strong>{currentUser.name}</strong><span>{formatPhone(currentUser.phone)}</span></div>
                  <button onClick={logout}><LogOut size={16} /> Sign out</button>
                </div>
              )}
            </div>
          </div>
        </header>

        <div className="workspace">
          <section className="ledger-column">
            {view === 'ledger' ? (
              <>
                <div className="page-heading">
                  <div>
                    <p>{new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</p>
                    <h1>Hello, {currentUser.name.split(' ')[0]}.</h1>
                  </div>
                  <button className="primary-button desktop-add" onClick={() => setShowAdd(true)}>
                    <Plus size={18} /> Add entry
                  </button>
                </div>

                <div className="balance-switch" role="tablist" aria-label="Choose ledger side">
                  <button
                    role="tab"
                    aria-selected={direction === 'receivable'}
                    className={direction === 'receivable' ? 'active receive' : ''}
                    onClick={() => setDirection('receivable')}
                  >
                    <span className="switch-icon"><ArrowDownLeft size={19} /></span>
                    <span><small>You owe me</small><strong>{direction === 'receivable' ? money.format(total) : 'Money lent'}</strong></span>
                  </button>
                  <button
                    role="tab"
                    aria-selected={direction === 'payable'}
                    className={direction === 'payable' ? 'active pay' : ''}
                    onClick={() => setDirection('payable')}
                  >
                    <span className="switch-icon"><ArrowUpRight size={19} /></span>
                    <span><small>I owe you</small><strong>{direction === 'payable' ? money.format(total) : 'Money borrowed'}</strong></span>
                  </button>
                </div>

                <div className="ledger-toolbar">
                  <div>
                    <h2>{direction === 'receivable' ? 'Money coming back' : 'Money to pay back'}</h2>
                    <p>{summaries.length} {summaries.length === 1 ? 'person' : 'people'} · {openEntries} open {openEntries === 1 ? 'entry' : 'entries'}</p>
                  </div>
                  <label className="search-box">
                    <Search size={17} />
                    <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a person" />
                  </label>
                </div>

                <div className="people-list">
                  {dataLoading && <div className="ledger-loading">Syncing your ledger…</div>}
                  {!dataLoading && summaries.map((summary) => (
                    <button
                      className="person-row"
                      key={summary.person.phone}
                      onClick={() => setSelectedPhone(normalizePhone(summary.person.phone))}
                    >
                      <Avatar person={summary.person} />
                      <span className="person-copy">
                        <strong>{summary.person.name}</strong>
                        <small>{summary.openCount} {summary.openCount === 1 ? 'entry' : 'entries'} · Latest {shortDate.format(new Date(`${summary.latestDate}T00:00:00`))}</small>
                      </span>
                      <span className="person-amount">
                        <strong className={direction === 'payable' ? 'amount-negative' : ''}>{money.format(summary.total)}</strong>
                        <small>{direction === 'receivable' ? 'owes you' : 'you owe'}</small>
                      </span>
                      <ChevronLeft className="row-chevron" size={18} />
                    </button>
                  ))}
                  {!dataLoading && summaries.length === 0 && (
                    <div className="empty-state">
                      <span><UsersRound size={24} /></span>
                      <h3>{search ? 'No one found' : 'Nothing to settle here'}</h3>
                      <p>{search ? 'Try another name.' : `Add an entry when ${direction === 'receivable' ? 'you pay for someone' : 'someone pays for you'}.`}</p>
                      {!search && <button className="secondary-button" onClick={() => setShowAdd(true)}><Plus size={17} /> Add entry</button>}
                    </div>
                  )}
                </div>
              </>
            ) : view === 'activity' ? (
              <section className="activity-view">
                <div className="page-heading activity-heading">
                  <div><p>Your complete trail</p><h1>Activity</h1></div>
                </div>
                <div className="activity-tabs">
                  <button className={direction === 'receivable' ? 'active' : ''} onClick={() => setDirection('receivable')}>You owe me</button>
                  <button className={direction === 'payable' ? 'active' : ''} onClick={() => setDirection('payable')}>I owe you</button>
                </div>
                <div className="activity-list">
                  {recentEntries.map((entry) => {
                    const person = direction === 'receivable' ? entry.borrower : entry.lender
                    const Icon = methodIcons[entry.method]
                    return (
                      <article className="activity-row" key={entry.id}>
                        <span className={`activity-state ${entry.status}`}>
                          {entry.status === 'settled' ? <Check size={17} /> : <Icon size={17} />}
                        </span>
                        <div>
                          <h3>{entry.occasion}</h3>
                          <p>{person.name} · {entry.method} · {shortDate.format(new Date(`${entry.date}T00:00:00`))}</p>
                        </div>
                        <div className="activity-amount">
                          <strong>{money.format(entry.amount)}</strong>
                          <span className={entry.status}>{entry.status === 'settled' ? 'Paid' : 'Open'}</span>
                        </div>
                      </article>
                    )
                  })}
                </div>
              </section>
            ) : (
              <SplitWorkspace currentUser={currentUser} onNotice={setToast} />
            )}
          </section>

          {view !== 'splits' && <aside className="insights-column">
            <section className="snapshot-card">
              <div className="snapshot-title"><h2>At a glance</h2><span className={direction}>{direction === 'receivable' ? 'To receive' : 'To pay'}</span></div>
              <strong className={direction === 'payable' ? 'amount-negative' : ''}>{money.format(total)}</strong>
              <p>across {summaries.length} {summaries.length === 1 ? 'person' : 'people'}</p>
              <div className="snapshot-rule" />
              <div className="snapshot-meta"><span>Open entries</span><strong>{openEntries}</strong></div>
              <div className="snapshot-meta"><span>Largest balance</span><strong>{summaries[0]?.person.name ?? '—'}</strong></div>
            </section>

            <section className="methods-card">
              <div className="side-card-heading"><h2>By payment method</h2><span>{openEntries} entries</span></div>
              <div className="method-stack">
                {methodTotals.map(([method, amount]) => {
                  const Icon = methodIcons[method]
                  const percentage = total ? Math.round((amount / total) * 100) : 0
                  return (
                    <div className="method-row" key={method}>
                      <span className="method-icon"><Icon size={17} /></span>
                      <div><strong>{method}</strong><span><i style={{ width: `${percentage}%` }} /></span></div>
                      <em>{money.format(amount)}</em>
                    </div>
                  )
                })}
                {methodTotals.length === 0 && <p className="quiet-empty">No open payments yet.</p>}
              </div>
            </section>

            <section className="privacy-card">
              <ShieldCheck size={20} />
              <div><strong>Shared, not public</strong><p>Each entry is visible only to the two mobile numbers on it.</p></div>
            </section>
          </aside>}
        </div>
      </main>

      <button className="mobile-fab" onClick={() => setShowAdd(true)} aria-label="Add entry"><Plus size={23} /></button>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        <button className={view === 'ledger' ? 'active' : ''} onClick={() => setView('ledger')}><ReceiptText size={20} /><span>Ledger</span></button>
        <button className={view === 'activity' ? 'active' : ''} onClick={() => setView('activity')}><History size={20} /><span>Activity</span></button>
        <button className={view === 'splits' ? 'active' : ''} onClick={() => setView('splits')}><Split size={20} /><span>Splits</span></button>
      </nav>

      {showAdd && <AddEntryModal initialDirection={direction} currentUser={currentUser} onClose={() => setShowAdd(false)} onSave={saveEntry} />}
      {selectedSummary && <PersonDrawer summary={selectedSummary} direction={direction} onClose={() => setSelectedPhone(null)} onSettle={markEntrySettled} />}
      {toast && <div className="toast" role="status"><CheckCircle2 size={18} /> {toast}</div>}
    </div>
  )
}

function App() {
  const match = window.location.pathname.match(/^\/split\/([a-z0-9-]+)\/?$/i)
  if (match) return <SplitPublicPage splitId={match[1]} />
  return <TallyBackApp />
}

export default App
