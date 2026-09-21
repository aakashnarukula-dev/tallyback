import { type CSSProperties, ChangeEvent, FormEvent, lazy, Suspense, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ConfirmationResult,
  onAuthStateChanged,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  signOut as signOutOfFirebase,
  User,
} from 'firebase/auth'
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  Bell,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Contact,
  CreditCard,
  Flag,
  History,
  Image as ImageIcon,
  ImagePlus,
  Landmark,
  LoaderCircle,
  LogOut,
  Pencil,
  Plus,
  ReceiptText,
  Search,
  ShieldCheck,
  Split,
  Smartphone,
  Trash2,
  WalletCards,
  X,
} from 'lucide-react'
import {
  LedgerActivity,
  getSplitLedgerReference,
  LedgerEntry,
  LedgerReview,
  LedgerReviewRecord,
  normalizePhone,
  PaymentScreenshot,
  PaymentMethod,
  Person,
  RepaymentRequest,
  SavedContact,
} from './data'
import { auth, isFirebaseConfigured } from './firebase'
import {
  createEntry as createFirebaseEntry,
  deleteEntry as deleteFirebaseEntry,
  getUserProfile,
  saveUserProfile,
  subscribeToEntries,
  syncParticipantName,
  toE164,
  updateEntry as updateFirebaseEntry,
} from './firebase-ledger'
import {
  canPickDeviceContacts,
  deleteContact as deleteFirebaseContact,
  pickDeviceContacts,
  saveContact,
  saveContacts,
  subscribeToContacts,
} from './firebase-contacts'
import {
  createReviewRequest,
  resolveReviewRequest,
  ReviewDraft,
  subscribeToReviewRecords,
} from './firebase-reviews'
import { subscribeToActivities } from './firebase-activity'
import {
  createRepaymentRequest,
  recordLenderPayment,
  RepaymentDraft,
  resolveRepaymentRequest,
  subscribeToRepaymentRequests,
} from './firebase-repayments'
import {
  acceptedScreenshotTypes,
  deletePaymentScreenshots,
  loadPaymentScreenshot,
  MAX_PAYMENT_SCREENSHOTS,
  MAX_SCREENSHOT_SIZE,
  uploadPaymentScreenshots,
} from './firebase-storage'
import {
  canAttemptAutomaticTruecaller,
  ensureTruecallerLedgerClaim,
  prepareTruecaller,
  signInWithTruecaller,
  TruecallerInit,
} from './truecaller'
import {
  canonicalEntryStatus,
  entryOriginalAmount,
  entryPaidAmount,
  entryRemainingAmount,
  hasValidMoneyPrecision,
  isPaidEntry,
  outstandingTotals,
} from './ledger-calculations'

type Direction = 'receivable' | 'payable'
type View = 'ledger' | 'activity' | 'splits'

const SPLITS_ENABLED = false

type ContactSummary = {
  person: Person
  total: number
  openCount: number
  pendingCount: number
  entries: LedgerEntry[]
}

const SplitPublicPage = lazy(() => import('./SplitPublicPage'))
const SplitWorkspace = lazy(() => import('./SplitWorkspace'))

type ReviewSubmissionDraft = Omit<ReviewDraft, 'proofScreenshots'> & {
  proofFiles: File[]
}

type RepaymentSubmissionDraft = Omit<RepaymentDraft, 'proofScreenshots'> & {
  proofFiles: File[]
}

type ActivityItem =
  | { id: string; timestamp: number; kind: 'activity'; activity: LedgerActivity }
  | { id: string; timestamp: number; kind: 'entry'; entry: LedgerEntry }
  | { id: string; timestamp: number; kind: 'review-request' | 'review-resolution'; review: LedgerReviewRecord }
  | { id: string; timestamp: number; kind: 'repayment-request' | 'repayment-resolution'; repayment: RepaymentRequest }

const PROFILE_NAME_PLACEHOLDERS = new Set(['', 'tallyback member', 'my account'])
let dismissLayerSequence = 0

export function hasProfileName(name?: string | null) {
  return !PROFILE_NAME_PLACEHOLDERS.has(name?.trim().toLowerCase() ?? '')
}

export function useBrowserBackDismiss(onDismiss: () => void) {
  const onDismissRef = useRef(onDismiss)
  const mountedRef = useRef(false)
  const [layerId] = useState(() => `tallyback-dismiss-layer-${Date.now()}-${dismissLayerSequence += 1}`)

  onDismissRef.current = onDismiss

  useEffect(() => {
    mountedRef.current = true
    const currentState = window.history.state && typeof window.history.state === 'object'
      ? window.history.state
      : {}

    if (window.history.state?.tallyBackDismissLayer !== layerId) {
      window.history.pushState(
        { ...currentState, tallyBackDismissLayer: layerId },
        '',
        window.location.href,
      )
    }

    const closeOnBack = () => {
      if (window.history.state?.tallyBackDismissLayer === layerId) return
      onDismissRef.current()
    }

    window.addEventListener('popstate', closeOnBack)

    return () => {
      mountedRef.current = false
      window.removeEventListener('popstate', closeOnBack)

      queueMicrotask(() => {
        if (!mountedRef.current && window.history.state?.tallyBackDismissLayer === layerId) {
          window.history.back()
        }
      })
    }
  }, [layerId])
}

function timestampMillis(value: unknown) {
  if (value && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    return (value as { toMillis: () => number }).toMillis()
  }
  if (value instanceof Date) return value.getTime()
  const parsed = Date.parse(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
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

const dateTime = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
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

const today = () => {
  const value = new Date()
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const calendarMonth = new Intl.DateTimeFormat('en-IN', {
  month: 'long',
  year: 'numeric',
})

const calendarDayLabel = new Intl.DateTimeFormat('en-IN', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

function parseCalendarDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function calendarDateValue(value: Date) {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function DatePicker({ value, onChange, max }: { value: string; onChange: (value: string) => void; max?: string }) {
  const selectedDate = parseCalendarDate(value)
  const [open, setOpen] = useState(false)
  const [visibleMonth, setVisibleMonth] = useState(
    () => new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1),
  )
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setVisibleMonth(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1))
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      setOpen(false)
      requestAnimationFrame(() => triggerRef.current?.focus())
    }
    window.addEventListener('keydown', closeOnEscape, true)
    requestAnimationFrame(() => dialogRef.current?.focus())
    return () => window.removeEventListener('keydown', closeOnEscape, true)
  }, [open, value])

  const monthStart = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1)
  const gridStart = new Date(monthStart)
  gridStart.setDate(1 - monthStart.getDay())
  const daysInGrid = Array.from({ length: 42 }, (_, index) => {
    const day = new Date(gridStart)
    day.setDate(gridStart.getDate() + index)
    return day
  })
  const todayValue = today()

  function closePicker() {
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  function chooseDate(day: Date) {
    const nextValue = calendarDateValue(day)
    if (max && nextValue > max) return
    onChange(nextValue)
    closePicker()
  }

  const nextMonthValue = calendarDateValue(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1))

  return (
    <>
      <button
        ref={triggerRef}
        className="date-picker-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span>{selectedDate.toLocaleDateString('en-GB')}</span>
        <CalendarDays size={17} aria-hidden="true" />
      </button>
      {open ? createPortal(
        <div className="date-picker-layer" role="presentation" onPointerDown={(event) => {
          if (event.target === event.currentTarget) closePicker()
        }}>
          <div
            ref={dialogRef}
            className="date-picker-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Choose date"
            tabIndex={-1}
          >
            <div className="date-picker-header">
              <strong>{calendarMonth.format(visibleMonth)}</strong>
              <div>
                <button
                  type="button"
                  aria-label="Previous month"
                  onClick={() => setVisibleMonth(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1))}
                ><ChevronLeft size={18} /></button>
                <button
                  type="button"
                  aria-label="Next month"
                  disabled={Boolean(max && nextMonthValue > max)}
                  onClick={() => setVisibleMonth(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1))}
                ><ChevronRight size={18} /></button>
              </div>
            </div>
            <div className="date-picker-weekdays" aria-hidden="true">
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}
            </div>
            <div className="date-picker-grid">
              {daysInGrid.map((day) => {
                const dayValue = calendarDateValue(day)
                const outsideMonth = day.getMonth() !== visibleMonth.getMonth()
                return (
                  <button
                    type="button"
                    key={dayValue}
                    className={`${outsideMonth ? 'outside' : ''} ${dayValue === value ? 'selected' : ''} ${dayValue === todayValue ? 'today' : ''}`}
                    aria-label={calendarDayLabel.format(day)}
                    aria-pressed={dayValue === value}
                    disabled={Boolean(max && dayValue > max)}
                    onClick={() => chooseDate(day)}
                  >{day.getDate()}</button>
                )
              })}
            </div>
            <div className="date-picker-footer">
              <button type="button" onClick={() => chooseDate(new Date())}>Today</button>
              <button type="button" onClick={closePicker}>Cancel</button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  )
}

const avatarPalettes = [
  { background: '#dfe7ff', shirt: '#5963d9', hair: '#29324b', skin: '#f4c7a1' },
  { background: '#ffe8bd', shirt: '#d66a55', hair: '#52372c', skin: '#d99b72' },
  { background: '#d9f3e7', shirt: '#33816d', hair: '#252b36', skin: '#8f5c42' },
  { background: '#f2ddf6', shirt: '#8856a7', hair: '#683c2e', skin: '#f0b98f' },
  { background: '#dff2f7', shirt: '#287a96', hair: '#1f2937', skin: '#c9825d' },
  { background: '#f7dfdf', shirt: '#b94c64', hair: '#47352f', skin: '#6f422f' },
]

function avatarSeed(person: Person) {
  const source = normalizePhone(person.phone) || person.name
  let value = 2166136261
  for (const character of source) {
    value ^= character.charCodeAt(0)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

function CartoonAvatar({ person }: { person: Person }) {
  const seed = avatarSeed(person)
  const palette = avatarPalettes[seed % avatarPalettes.length]
  const hairStyle = seed % 4
  const wearsGlasses = seed % 3 === 0
  const smiles = seed % 2 === 0

  return (
    <svg viewBox="0 0 64 64" focusable="false">
      <rect width="64" height="64" rx="32" fill={palette.background} />
      <path d="M10 64c1-13 9-20 22-20s21 7 22 20" fill={palette.shirt} />
      <circle cx="15.5" cy="29" r="5" fill={palette.skin} />
      <circle cx="48.5" cy="29" r="5" fill={palette.skin} />
      <path d="M17 27c0-12 6-19 15-19s15 7 15 19v7c0 10-6 17-15 17s-15-7-15-17Z" fill={palette.skin} />
      {hairStyle === 0 ? <path d="M16 29c0-14 7-22 17-22 8 0 14 5 16 14-5-1-9-4-12-8-4 6-11 10-21 11Z" fill={palette.hair} /> : null}
      {hairStyle === 1 ? <path d="M16 30c-1-13 5-23 17-23 11 0 16 8 16 20-4-6-7-9-13-12-3 6-10 10-20 11Z" fill={palette.hair} /> : null}
      {hairStyle === 2 ? <><circle cx="43" cy="10" r="7" fill={palette.hair} /><path d="M16 28c0-13 7-21 17-21 8 0 13 5 16 14-8 0-14-3-18-8-3 5-8 9-15 11Z" fill={palette.hair} /></> : null}
      {hairStyle === 3 ? <path d="M15 29c0-15 6-22 17-22 12 0 18 8 17 23l-4-2c-1-8-5-12-13-14-3 6-8 10-17 12Z" fill={palette.hair} /> : null}
      <circle cx="26" cy="30" r="1.7" fill="#252b36" />
      <circle cx="38" cy="30" r="1.7" fill="#252b36" />
      <circle cx="22" cy="36" r="2" fill="#e99387" opacity="0.5" />
      <circle cx="42" cy="36" r="2" fill="#e99387" opacity="0.5" />
      {wearsGlasses ? <g fill="none" stroke="#48536b" strokeWidth="1.5"><circle cx="25" cy="30" r="5" /><circle cx="39" cy="30" r="5" /><path d="M30 30h4" /></g> : null}
      <path d={smiles ? 'M27 39c2.6 3 7.4 3 10 0' : 'M28 40c2.4-1.5 5.6-1.5 8 0'} fill="none" stroke="#7c4038" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function Avatar({ person, size = 'md' }: { person: Person; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span
      className={`avatar avatar-${size}`}
      aria-hidden="true"
    >
      <CartoonAvatar person={person} />
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
  return clean.length === 10 ? clean : phone
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

function firebaseErrorDetails(error: unknown) {
  if (!error || typeof error !== 'object') return { code: '', message: String(error) }
  const firebaseError = error as { code?: unknown; message?: unknown }
  return {
    code: typeof firebaseError.code === 'string' ? firebaseError.code : '',
    message: typeof firebaseError.message === 'string' ? firebaseError.message : String(error),
  }
}

function actionableFirebaseError(error: unknown, fallback: string) {
  const { code, message } = firebaseErrorDetails(error)
  if (message && !message.startsWith('FirebaseError:') && !message.includes('Missing or insufficient permissions')) {
    return message
  }
  if (code === 'storage/unauthenticated' || code === 'auth/id-token-expired' || code === 'auth/user-token-expired') {
    return 'Access expired. Sign in again, then retry.'
  }
  if (code === 'storage/unauthorized') return 'Screenshot access denied. Refresh this due and retry.'
  if (code === 'permission-denied') return 'Payment update was denied. Refresh this due and confirm the signed-in account.'
  if (code === 'storage/retry-limit-exceeded' || code === 'unavailable') return 'Connection interrupted. Check internet and retry.'
  if (code === 'storage/quota-exceeded' || code === 'resource-exhausted') return 'Upload limit reached. Try again later.'
  return fallback
}

async function getAuthenticatedPhone(user: User, forceRefresh = false) {
  const tokenResult = await user.getIdTokenResult(forceRefresh)
  const claimedPhone = typeof tokenResult.claims.phone_number === 'string'
    ? tokenResult.claims.phone_number
    : typeof tokenResult.claims.verifiedPhone === 'string'
      ? tokenResult.claims.verifiedPhone
      : ''
  const phone = user.phoneNumber || claimedPhone
  return normalizePhone(phone).length === 10 ? toE164(phone) : ''
}

function LoginScreen({
  onAuthenticated,
}: {
  onAuthenticated: (uid: string, person: Person) => void
}) {
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [confirmation, setConfirmation] = useState<ConfirmationResult | null>(null)
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  const [truecallerWorking, setTruecallerWorking] = useState(false)
  const [truecallerArmed, setTruecallerArmed] = useState(false)
  const truecallerController = useRef<AbortController | null>(null)
  const otpController = useRef<AbortController | null>(null)
  const truecallerInit = useRef<TruecallerInit | null>(null)
  const verificationAttempt = useRef('')

  useEffect(() => {
    if (!auth || !isFirebaseConfigured || !canAttemptAutomaticTruecaller()) return
    const controller = new AbortController()
    truecallerController.current = controller

    prepareTruecaller().then((prepared) => {
      if (!prepared || controller.signal.aborted) return
      truecallerInit.current = prepared
      setTruecallerArmed(true)
    })

    return () => {
      controller.abort()
      if (truecallerController.current === controller) truecallerController.current = null
      truecallerInit.current = null
    }
  }, [])

  useEffect(() => () => otpController.current?.abort(), [])

  function activateTruecaller() {
    const prepared = truecallerInit.current
    const controller = truecallerController.current
    if (!prepared || !controller || controller.signal.aborted || working || confirmation) return

    truecallerInit.current = null
    setTruecallerArmed(false)
    signInWithTruecaller({
      prepared,
      signal: controller.signal,
      onLaunch: () => setTruecallerWorking(true),
      onFallback: () => setTruecallerWorking(false),
    }).then(async (result) => {
      if (!result || controller.signal.aborted) return
      const person = {
        name: result.profile.name || result.user.displayName || 'TallyBack member',
        phone: result.user.phoneNumber || toE164(result.profile.phone || ''),
      }
      await saveUserProfile(result.user.uid, person)
      onAuthenticated(result.user.uid, person)
    }).catch((truecallerError) => {
      if ((truecallerError as Error).name !== 'AbortError') {
        console.warn('Automatic Truecaller sign-in unavailable:', truecallerError)
      }
      setTruecallerWorking(false)
    })
  }

  useEffect(() => {
    if (!confirmation || code.length !== 6 || verificationAttempt.current === code) return

    verificationAttempt.current = code
    setError('')
    setWorking(true)

    confirmation.confirm(code).then(async (credential) => {
      const existingProfile = await getUserProfile(credential.user.uid)
      const person = {
        name: existingProfile?.name || credential.user.displayName || 'TallyBack member',
        phone: credential.user.phoneNumber ?? toE164(phone),
      }
      await saveUserProfile(credential.user.uid, person)
      onAuthenticated(credential.user.uid, person)
    }).catch((verificationError) => {
      setError(authErrorMessage(verificationError))
    }).finally(() => {
      setWorking(false)
    })
  }, [code, confirmation, onAuthenticated, phone])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (confirmation) return

    setError('')
    truecallerController.current?.abort()
    truecallerController.current = null
    truecallerInit.current = null
    setTruecallerArmed(false)
    setTruecallerWorking(false)

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
      otpController.current?.abort()
      otpController.current = null

      if ('OTPCredential' in window && navigator.credentials) {
        const controller = new AbortController()
        otpController.current = controller

        navigator.credentials.get({
          otp: { transport: ['sms'] },
          signal: controller.signal,
        } as CredentialRequestOptions & {
          otp: { transport: ['sms'] }
          signal: AbortSignal
        }).then((credential) => {
          const receivedCode = (credential as (Credential & { code?: string }) | null)?.code
            ?.replace(/[^0-9]/g, '')
            .slice(0, 6)
          if (receivedCode && !controller.signal.aborted) changeCode(receivedCode)
        }).catch((otpError) => {
          const errorName = (otpError as Error).name
          if (errorName !== 'AbortError' && errorName !== 'NotAllowedError') {
            console.warn('SMS code autofill unavailable:', otpError)
          }
        }).finally(() => {
          if (otpController.current === controller) otpController.current = null
        })
      }

      recaptchaVerifier?.clear()
      recaptchaVerifier = new RecaptchaVerifier(auth, 'phone-sign-in-button', {
        size: 'invisible',
      })
      const result = await signInWithPhoneNumber(auth, toE164(phone), recaptchaVerifier)
      setConfirmation(result)
    } catch (signInError) {
      otpController.current?.abort()
      otpController.current = null
      recaptchaVerifier?.clear()
      recaptchaVerifier = null
      setError(authErrorMessage(signInError))
    } finally {
      setWorking(false)
    }
  }

  function changePhone(nextPhone: string) {
    const normalizedPhone = nextPhone.replace(/[^0-9]/g, '').slice(0, 10)

    if (confirmation && normalizedPhone !== phone) {
      otpController.current?.abort()
      otpController.current = null
      setConfirmation(null)
      setCode('')
      verificationAttempt.current = ''
      setError('')
      recaptchaVerifier?.clear()
      recaptchaVerifier = null
    }

    setPhone(normalizedPhone)
  }

  function changeCode(nextCode: string) {
    const normalizedCode = nextCode.replace(/[^0-9]/g, '').slice(0, 6)
    if (normalizedCode.length === 6) {
      otpController.current?.abort()
      otpController.current = null
    }
    verificationAttempt.current = ''
    setError('')
    setCode(normalizedCode)
  }

  return (
    <main className="login-page">
      {truecallerArmed && (
        <button
          type="button"
          className="truecaller-activation-layer"
          aria-hidden="true"
          tabIndex={-1}
          onClick={activateTruecaller}
        />
      )}
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
          {confirmation ? <p className="login-step">Check your messages</p> : null}
          <h2>{confirmation ? 'Enter your code.' : 'Know what you owe and what you’re owed.'}</h2>
          <p className="login-subtitle">
            {confirmation
              ? `We sent a 6-digit verification code to +91 ${phone.slice(0, 5)} ${phone.slice(5)}.`
              : 'Track money people owe you and see how much you need to pay others.'}
          </p>
          <label>
            Mobile number
            <div className="phone-input">
              <span>+91</span>
              <input
                value={phone}
                onChange={(event) => changePhone(event.target.value)}
                placeholder="98765 43210"
                inputMode="numeric"
                autoComplete="tel"
              />
            </div>
          </label>
          {truecallerWorking && !confirmation ? (
            <div className="automatic-login-status" role="status" aria-live="polite">
              <span className="automatic-login-spinner" aria-hidden="true" />
              <div>
                <strong>Finishing secure sign-in…</strong>
                <span>Confirm in Truecaller to continue.</span>
              </div>
            </div>
          ) : confirmation && (
            <label>
              Verification code
              <div className="input-shell verification-input">
                <ShieldCheck size={18} />
                <input
                  value={code}
                  onChange={(event) => changeCode(event.target.value)}
                  placeholder="000000"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={6}
                  disabled={working}
                  aria-describedby="otp-help"
                  autoFocus
                />
              </div>
              <span id="otp-help" className="field-help" role="status" aria-live="polite">
                {working ? 'Verifying code…' : 'Verification starts automatically after 6 digits.'}
              </span>
            </label>
          )}
          {error && <p className="form-error">{error}</p>}
          {!truecallerWorking && !confirmation && (
            <button
              id="phone-sign-in-button"
              className="primary-button login-button"
              type="submit"
              disabled={working}
            >
              {working ? 'Please wait…' : 'Text me a code'}
            </button>
          )}
          <div id="recaptcha-container" />
        </form>
      </section>
    </main>
  )
}

export function RequiredNameModal({ onSave }: { onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.history.pushState({ ...window.history.state, tallyBackRequiredName: true }, '', window.location.href)

    const keepOpenOnBack = () => {
      window.history.pushState({ ...window.history.state, tallyBackRequiredName: true }, '', window.location.href)
    }
    const blockEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    window.addEventListener('popstate', keepOpenOnBack)
    window.addEventListener('keydown', blockEscape, true)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('popstate', keepOpenOnBack)
      window.removeEventListener('keydown', blockEscape, true)
      if (window.history.state?.tallyBackRequiredName) {
        window.history.back()
      }
    }
  }, [])

  async function submitName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const cleanName = name.trim()
    if (!hasProfileName(cleanName)) {
      setError('Enter your name to continue.')
      return
    }

    setSaving(true)
    setError('')
    try {
      await onSave(cleanName)
    } catch (saveError) {
      console.error('[profile/name]', saveError)
      setError(saveError instanceof Error ? saveError.message : 'Could not save your name. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="required-name-backdrop">
      <section
        className="required-name-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="required-name-title"
        aria-describedby="required-name-description"
      >
        <div className="required-name-handle" aria-hidden="true" />
        <p className="required-name-eyebrow">One last step</p>
        <h2 id="required-name-title">What should we call you?</h2>
        <p id="required-name-description" className="required-name-description">
          This name appears on dues you share with other people.
        </p>

        <form onSubmit={submitName} className="required-name-form">
          <label htmlFor="required-profile-name">Your name</label>
          <input
            id="required-profile-name"
            type="text"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              if (error) setError('')
            }}
            placeholder="Aakash"
            autoComplete="name"
            enterKeyHint="done"
            maxLength={60}
            disabled={saving}
            required
          />
          {error && <p className="required-name-error" role="alert">{error}</p>}
          <button type="submit" disabled={saving || !hasProfileName(name)}>
            {saving ? 'Saving…' : 'Save name'}
          </button>
        </form>
      </section>
    </div>
  )
}

function AddPersonModal({
  onClose,
  onSave,
  onImport,
  contactPickerAvailable,
}: {
  onClose: () => void
  onSave: (person: Person) => Promise<void>
  onImport: () => Promise<void>
  contactPickerAvailable: boolean
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  const sheetRef = useRef<HTMLElement>(null)
  const closeTimerRef = useRef<number | null>(null)
  const dragStartRef = useRef({ y: 0, time: 0 })
  const dragYRef = useRef(0)
  const workingRef = useRef(false)
  const closingRef = useRef(false)
  const [dragging, setDragging] = useState(false)
  const [closing, setClosing] = useState(false)

  workingRef.current = working

  function closeSheet(force = false) {
    if (closingRef.current || (workingRef.current && !force)) return
    closingRef.current = true
    setClosing(true)
    setDragging(false)
    closeTimerRef.current = window.setTimeout(onClose, 160)
  }

  useBrowserBackDismiss(() => closeSheet())

  function startDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || closingRef.current || workingRef.current) return
    dragStartRef.current = { y: event.clientY, time: performance.now() }
    dragYRef.current = 0
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!dragging || closingRef.current) return
    const nextDragY = Math.max(0, event.clientY - dragStartRef.current.y)
    dragYRef.current = nextDragY
    sheetRef.current?.style.setProperty('--sheet-drag-y', `${nextDragY}px`)
  }

  function finishDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!dragging || closingRef.current) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const elapsed = Math.max(performance.now() - dragStartRef.current.time, 1)
    const velocity = dragYRef.current / elapsed
    if (dragYRef.current > Math.min(130, window.innerHeight * 0.16) || (dragYRef.current > 28 && velocity > 0.55)) {
      closeSheet()
      return
    }
    dragYRef.current = 0
    setDragging(false)
    sheetRef.current?.style.setProperty('--sheet-drag-y', '0px')
  }

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    sheetRef.current?.focus()

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSheet()
    }
    window.addEventListener('keydown', closeOnEscape)

    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    }
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim() || normalizePhone(phone).length !== 10) {
      setError('Add contact name and valid 10-digit mobile number.')
      return
    }

    try {
      setWorking(true)
      setError('')
      await onSave({ name: name.trim(), phone: toE164(phone) })
      closeSheet(true)
    } catch (saveError) {
      setError((saveError as Error).message || 'Could not save this person. Check connection and try again.')
    } finally {
      setWorking(false)
    }
  }

  async function importContacts() {
    try {
      setWorking(true)
      setError('')
      await onImport()
    } catch (importError) {
      if ((importError as Error).name !== 'AbortError') {
        setError((importError as Error).message || 'Could not open device contacts.')
      }
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className={`modal-backdrop add-person-backdrop ${closing ? 'closing' : ''}`} role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) closeSheet() }}>
      <section
        ref={sheetRef}
        className={`modal-card add-person-modal ${dragging ? 'dragging' : ''} ${closing ? 'closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Add person"
        tabIndex={-1}
        style={{ '--sheet-drag-y': '0px' } as CSSProperties}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          className="add-person-grabber"
          type="button"
          aria-label="Drag down to close add person"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
        ><span /></button>

        {contactPickerAvailable ? (
          <button className="contact-import-card" type="button" onClick={importContacts} disabled={working}>
            <span><Contact size={20} /></span>
            <span><strong>Choose from contacts</strong><small>Select one or more people from your phone</small></span>
            <ChevronRight size={18} />
          </button>
        ) : null}

        {contactPickerAvailable ? <div className="modal-separator"><span>or enter manually</span></div> : null}

        <form onSubmit={submit}>
          <div className="person-form-grid">
            <label>
              Contact name
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Aakash" autoComplete="name" maxLength={120} autoFocus={!contactPickerAvailable} />
            </label>
            <label>
              Mobile number
              <div className="phone-input compact">
                <span>+91</span>
                <input value={phone} onChange={(event) => setPhone(event.target.value.replace(/[^0-9]/g, '').slice(0, 10))} placeholder="9876543210" inputMode="numeric" autoComplete="tel" />
              </div>
            </label>
          </div>
          {error ? <p className="form-error">{error}</p> : null}
          <div className="modal-actions">
            <button className="secondary-button" type="button" onClick={() => closeSheet()} disabled={working}>Cancel</button>
            <button className="primary-button" type="submit" disabled={working}>{working ? 'Saving…' : 'Save person'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

function AddEntryModal({
  currentUser,
  contact,
  entry,
  onClose,
  onSave,
}: {
  currentUser: Person
  contact: Person
  entry?: LedgerEntry
  onClose: () => void
  onSave: (entry: LedgerEntry) => Promise<void>
}) {
  const [amount, setAmount] = useState(entry ? String(entryOriginalAmount(entry)) : '')
  const [occasion, setOccasion] = useState(entry?.occasion ?? '')
  const [method, setMethod] = useState<PaymentMethod>(entry?.method ?? 'UPI')
  const [date, setDate] = useState(entry?.date ?? today())
  const [error, setError] = useState('')
  const [screenshots, setScreenshots] = useState<Array<{
    id: string
    file: File
    previewUrl: string
  }>>([])
  const [existingScreenshots, setExistingScreenshots] = useState<PaymentScreenshot[]>(entry?.screenshots ?? [])
  const [removedScreenshots, setRemovedScreenshots] = useState<PaymentScreenshot[]>([])
  const [saving, setSaving] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{ completed: number; total: number } | null>(null)
  const screenshotInput = useRef<HTMLInputElement | null>(null)
  const previewUrls = useRef(new Set<string>())
  const sheetRef = useRef<HTMLElement>(null)
  const closeTimerRef = useRef<number | null>(null)
  const dragStartRef = useRef({ y: 0, time: 0 })
  const dragYRef = useRef(0)
  const draggingRef = useRef(false)
  const savingRef = useRef(false)
  const closingRef = useRef(false)
  const [dragging, setDragging] = useState(false)
  const [closing, setClosing] = useState(false)

  savingRef.current = saving

  function closeSheet(force = false) {
    if (closingRef.current || (savingRef.current && !force)) return
    closingRef.current = true
    draggingRef.current = false
    setClosing(true)
    setDragging(false)
    closeTimerRef.current = window.setTimeout(onClose, 160)
  }

  useBrowserBackDismiss(() => closeSheet())

  function startDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || closingRef.current || savingRef.current) return
    dragStartRef.current = { y: event.clientY, time: performance.now() }
    dragYRef.current = 0
    draggingRef.current = true
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveDrag(clientY: number) {
    if (!draggingRef.current || closingRef.current) return
    const nextDragY = Math.max(0, clientY - dragStartRef.current.y)
    dragYRef.current = nextDragY
    sheetRef.current?.style.setProperty('--sheet-drag-y', `${nextDragY}px`)
  }

  function finishDrag() {
    if (!draggingRef.current || closingRef.current) return
    draggingRef.current = false
    const elapsed = Math.max(performance.now() - dragStartRef.current.time, 1)
    const velocity = dragYRef.current / elapsed
    if (dragYRef.current > Math.min(130, window.innerHeight * 0.16) || (dragYRef.current > 28 && velocity > 0.55)) {
      closeSheet()
      return
    }
    dragYRef.current = 0
    setDragging(false)
    sheetRef.current?.style.setProperty('--sheet-drag-y', '0px')
  }

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSheet()
    }
    const moveSheet = (event: PointerEvent) => moveDrag(event.clientY)
    const finishSheetDrag = () => finishDrag()
    window.addEventListener('keydown', closeOnEscape)
    window.addEventListener('pointermove', moveSheet)
    window.addEventListener('pointerup', finishSheetDrag)
    window.addEventListener('pointercancel', finishSheetDrag)

    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('pointermove', moveSheet)
      window.removeEventListener('pointerup', finishSheetDrag)
      window.removeEventListener('pointercancel', finishSheetDrag)
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
      previewUrls.current.forEach((url) => URL.revokeObjectURL(url))
      previewUrls.current.clear()
    }
  }, [])

  function addScreenshots(event: ChangeEvent<HTMLInputElement>) {
    const incoming = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    if (!incoming.length) return

    const remainingSlots = MAX_PAYMENT_SCREENSHOTS - existingScreenshots.length - screenshots.length
    const existingFiles = new Set(
      screenshots.map(({ file }) => `${file.name}:${file.size}:${file.lastModified}`),
    )
    const accepted: File[] = []
    let validationError = ''

    for (const file of incoming) {
      const fileKey = `${file.name}:${file.size}:${file.lastModified}`
      if (!acceptedScreenshotTypes.includes(file.type)) {
        validationError = 'Use PNG, JPG, or WebP images.'
        continue
      }
      if (file.size > MAX_SCREENSHOT_SIZE) {
        validationError = 'Each screenshot must be smaller than 6 MB.'
        continue
      }
      if (existingFiles.has(fileKey)) continue
      existingFiles.add(fileKey)
      accepted.push(file)
    }

    if (accepted.length > remainingSlots) {
      validationError = 'Attach only one screenshot.'
    }

    const nextScreenshots = accepted.slice(0, Math.max(remainingSlots, 0)).map((file) => {
      const previewUrl = URL.createObjectURL(file)
      previewUrls.current.add(previewUrl)
      return {
        id: `${file.name}-${file.size}-${file.lastModified}`,
        file,
        previewUrl,
      }
    })

    if (nextScreenshots.length) {
      setScreenshots((current) => [...current, ...nextScreenshots])
    }
    setError(validationError)
  }

  function removeScreenshot(id: string) {
    setScreenshots((current) => current.filter((screenshot) => {
      if (screenshot.id !== id) return true
      URL.revokeObjectURL(screenshot.previewUrl)
      previewUrls.current.delete(screenshot.previewUrl)
      return false
    }))
    setError('')
  }

  function removeExistingScreenshot(path: string) {
    const screenshot = existingScreenshots.find((item) => item.path === path)
    if (!screenshot) return
    setExistingScreenshots((current) => current.filter((item) => item.path !== path))
    setRemovedScreenshots((current) => current.some((item) => item.path === path)
      ? current
      : [...current, screenshot])
    setError('')
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const numericAmount = Number(amount)
    if (!numericAmount || numericAmount <= 0 || !occasion.trim()) {
      setError('Add the amount and what it was for.')
      return
    }
    if (!hasValidMoneyPrecision(numericAmount)) {
      setError('Enter an amount with no more than two decimal places.')
      return
    }

    if (!existingScreenshots.length && !screenshots.length) {
      setError('Add one receiver screenshot.')
      return
    }

    if (!auth?.currentUser) {
      setError('Sign in again before saving this entry.')
      return
    }

    const entryId = entry?.id ?? `loan-${Date.now()}`
    let uploadedScreenshots: PaymentScreenshot[] = []
    let saveStage: 'upload' | 'ledger' = 'upload'

    try {
      setSaving(true)
      setError('')
      // Refresh once before Storage so newly-created phone sessions carry the
      // latest claims and are not rejected by a stale cached ID token.
      const authenticatedPhone = await getAuthenticatedPhone(auth.currentUser, true)
      if (!authenticatedPhone || authenticatedPhone !== toE164(currentUser.phone)) {
        const identityError = new Error('Authenticated phone does not match the active ledger.') as Error & { code: string }
        identityError.code = 'auth/identity-mismatch'
        throw identityError
      }
      if (screenshots.length) {
        setUploadProgress({ completed: 0, total: screenshots.length })
        uploadedScreenshots = await uploadPaymentScreenshots(
          entryId,
          auth.currentUser.uid,
          screenshots.map(({ file }) => file),
          (completed, total) => setUploadProgress({ completed, total }),
        )
      }

      saveStage = 'ledger'
      await onSave({
        id: entryId,
        lender: entry?.lender ?? currentUser,
        borrower: entry?.borrower ?? contact,
        amount: numericAmount,
        occasion: occasion.trim(),
        method,
        date,
        status: entry?.status ?? 'open',
        ...(typeof entry?.originalAmount === 'number' ? { originalAmount: entry.originalAmount } : {}),
        ...(typeof entry?.paidAmount === 'number' ? { paidAmount: entry.paidAmount } : {}),
        ...(typeof entry?.remainingAmount === 'number' ? { remainingAmount: entry.remainingAmount } : {}),
        ...(entry?.lastRepaymentId ? { lastRepaymentId: entry.lastRepaymentId } : {}),
        ...(entry?.createdBy ? { createdBy: entry.createdBy } : {}),
        ...(entry?.review ? { review: entry.review } : {}),
        ...(existingScreenshots.length || uploadedScreenshots.length
          ? { screenshots: [...existingScreenshots, ...uploadedScreenshots] }
          : {}),
      })
      if (removedScreenshots.length) {
        try {
          await deletePaymentScreenshots(removedScreenshots)
        } catch (deleteError) {
          console.warn('[TallyBack] Removed screenshot cleanup failed', deleteError)
        }
      }
    } catch (saveError) {
      if (uploadedScreenshots.length) await deletePaymentScreenshots(uploadedScreenshots)
      const details = firebaseErrorDetails(saveError)
      console.error('[TallyBack] Due save failed', {
        stage: saveStage,
        code: details.code,
        message: details.message,
        entryId,
        uid: auth.currentUser.uid,
      })
      setError(details.code === 'auth/identity-mismatch'
        ? 'Signed-in number changed. Close this sheet and try again.'
        : saveStage === 'upload'
          ? 'Could not upload the payment screenshot. Refresh once and try again.'
          : `Could not ${entry ? 'update' : 'save'} this due. Refresh once and try again.`)
    } finally {
      setSaving(false)
      setUploadProgress(null)
    }
  }

  const saveLabel = saving
    ? uploadProgress
      ? `Uploading ${uploadProgress.completed}/${uploadProgress.total}`
      : 'Saving…'
    : entry ? 'Save changes' : 'Save entry'

  return (
    <div
      className={`modal-backdrop add-entry-backdrop ${closing ? 'closing' : ''}`}
      role="presentation"
      onPointerDown={(event) => { if (event.target === event.currentTarget) closeSheet() }}
    >
      <section
        ref={sheetRef}
        className={`modal-card add-entry-modal ${dragging ? 'dragging' : ''} ${closing ? 'closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-entry-title"
        style={{ '--sheet-drag-y': '0px' } as CSSProperties}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          className="add-entry-grabber"
          type="button"
          aria-label="Drag down to close add due"
          onPointerDown={startDrag}
        ><span /></button>
        <div className="modal-header add-entry-header">
          <div>
            <h2 id="add-entry-title">{entry ? 'Edit due' : 'Add due'}</h2>
          </div>
          <button className="icon-button" type="button" onClick={() => closeSheet()} aria-label="Close dialog" disabled={saving}>
            <X size={20} />
          </button>
        </div>

        <form className="add-entry-form" onSubmit={submit}>
          <div className="add-entry-body">
            <div className="form-grid entry-form-grid">
              <label className="amount-field">
                Amount
                <div className="money-input">
                  <span>₹</span>
                  <input
                    value={amount}
                    onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))}
                    placeholder="0"
                    inputMode="decimal"
                    autoFocus
                  />
                </div>
              </label>
              <label className="entry-occasion-field">
                What was it for?
                <input value={occasion} onChange={(event) => setOccasion(event.target.value)} placeholder="Dinner, tickets, rent…" />
              </label>
              <label className="entry-method-field">
                Paid using
                <select value={method} onChange={(event) => setMethod(event.target.value as PaymentMethod)}>
                  {methods.map((item) => <option key={item}>{item}</option>)}
                </select>
              </label>
              <div className="entry-date-field form-field">
                <span>Date</span>
                <DatePicker value={date} onChange={setDate} />
              </div>
            </div>

            <section className="payment-upload" aria-labelledby="payment-upload-title">
              <div className="payment-upload-heading">
                <div>
                  <strong id="payment-upload-title">Amount sent &amp; receiver screenshot</strong>
                  <span>Required · 1 screenshot · 6 MB maximum</span>
                </div>
                <button
                  className="payment-upload-button"
                  type="button"
                  onClick={() => screenshotInput.current?.click()}
                  disabled={saving || existingScreenshots.length + screenshots.length >= MAX_PAYMENT_SCREENSHOTS}
                >
                  <ImagePlus size={16} /> Add images
                </button>
                <input
                  ref={screenshotInput}
                  className="visually-hidden"
                  type="file"
                  accept={acceptedScreenshotTypes.join(',')}
                  onChange={addScreenshots}
                  aria-label="Upload receiver screenshots"
                />
              </div>

              {existingScreenshots.length ? (
                <PaymentScreenshotGallery
                  screenshots={existingScreenshots}
                  label="Receiver screenshot"
                  onRemove={removeExistingScreenshot}
                  removingDisabled={saving}
                />
              ) : null}

              {screenshots.length ? (
                <div className="payment-preview-rail" aria-label="Selected receiver screenshots">
                  {screenshots.map((screenshot, index) => (
                    <figure className="payment-preview-card" key={screenshot.id}>
                      <img src={screenshot.previewUrl} alt={`Receiver screenshot ${index + 1}`} />
                      <button
                        type="button"
                        onClick={() => removeScreenshot(screenshot.id)}
                        aria-label={`Remove ${screenshot.file.name}`}
                        disabled={saving}
                      >
                        <Trash2 size={13} />
                      </button>
                    </figure>
                  ))}
                </div>
              ) : null}
            </section>

            {error && <p className="form-error">{error}</p>}
          </div>
          <div className="modal-actions add-entry-actions">
            <button className="secondary-button" type="button" onClick={() => closeSheet()} disabled={saving}>Cancel</button>
            <button className="primary-button" type="submit" disabled={saving}>
              {saving ? <LoaderCircle className="spin" size={16} /> : null}
              {saveLabel}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}

function PaymentScreenshotGallery({
  screenshots,
  label,
  onRemove,
  removingDisabled = false,
  compact = false,
}: {
  screenshots: PaymentScreenshot[]
  label: string
  onRemove?: (path: string) => void
  removingDisabled?: boolean
  compact?: boolean
}) {
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({})
  const [failedPaths, setFailedPaths] = useState<string[]>([])
  const [activeScreenshot, setActiveScreenshot] = useState<{ url: string; name: string } | null>(null)
  const lightboxHistoryPushed = useRef(false)

  function closeActiveScreenshot() {
    if (lightboxHistoryPushed.current && window.history.state?.tallyBackScreenshot) {
      window.history.back()
      return
    }
    lightboxHistoryPushed.current = false
    setActiveScreenshot(null)
  }

  useEffect(() => {
    let cancelled = false
    const createdUrls: string[] = []

    screenshots.forEach((screenshot) => {
      loadPaymentScreenshot(screenshot).then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url)
          return
        }
        createdUrls.push(url)
        setImageUrls((current) => ({ ...current, [screenshot.path]: url }))
      }).catch(() => {
        if (!cancelled) setFailedPaths((current) => [...current, screenshot.path])
      })
    })

    return () => {
      cancelled = true
      createdUrls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [screenshots])

  useEffect(() => {
    if (!activeScreenshot) return
    window.history.pushState({ ...window.history.state, tallyBackScreenshot: true }, '', window.location.href)
    lightboxHistoryPushed.current = true

    function closeOnHistoryBack() {
      lightboxHistoryPushed.current = false
      setActiveScreenshot(null)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') closeActiveScreenshot()
    }
    window.addEventListener('popstate', closeOnHistoryBack)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('popstate', closeOnHistoryBack)
      window.removeEventListener('keydown', closeOnEscape)
      if (lightboxHistoryPushed.current && window.history.state?.tallyBackScreenshot) {
        lightboxHistoryPushed.current = false
        window.history.back()
      }
    }
  }, [activeScreenshot])

  return (
    <div className={`ledger-proof-block ${compact ? 'ledger-proof-compact' : ''}`}>
      <div className="ledger-proof-heading">
        <span><ImageIcon size={13} /> {label}</span>
        <small>{screenshots.length} {screenshots.length === 1 ? 'image' : 'images'}</small>
      </div>
      <div className="ledger-proof-rail">
        {screenshots.map((screenshot, index) => {
          const imageUrl = imageUrls[screenshot.path]
          const failed = failedPaths.includes(screenshot.path)
          return (
            <div className="ledger-proof-item" key={screenshot.path}>
              <button
                type="button"
                className="ledger-proof-image"
                onClick={() => imageUrl && setActiveScreenshot({ url: imageUrl, name: screenshot.name })}
                disabled={!imageUrl}
                aria-label={`View ${label.toLowerCase()} ${index + 1}`}
              >
                {imageUrl ? (
                  <img src={imageUrl} alt="" />
                ) : failed ? (
                  <span><ImageIcon size={18} /> Unavailable</span>
                ) : (
                  <span><LoaderCircle className="spin" size={18} /> Loading</span>
                )}
              </button>
              {onRemove ? (
                <button
                  type="button"
                  className="ledger-proof-remove"
                  onClick={() => onRemove(screenshot.path)}
                  disabled={removingDisabled}
                  aria-label={`Remove ${screenshot.name || `${label.toLowerCase()} ${index + 1}`}`}
                >
                  <Trash2 size={13} />
                </button>
              ) : null}
            </div>
          )
        })}
      </div>

      {activeScreenshot ? createPortal(
        <div className="screenshot-lightbox" role="presentation" onPointerDown={closeActiveScreenshot}>
          <section role="dialog" aria-modal="true" aria-label={label} onPointerDown={(event) => event.stopPropagation()}>
            <img src={activeScreenshot.url} alt={activeScreenshot.name} />
          </section>
        </div>,
        document.body,
      ) : null}
    </div>
  )
}

export function RepaymentModal({
  entry,
  mode,
  onClose,
  onSend,
}: {
  entry: LedgerEntry
  mode: 'request' | 'record'
  onClose: () => void
  onSend: (draft: RepaymentSubmissionDraft) => Promise<void>
}) {
  const remainingDue = entryRemainingAmount(entry)
  const screenshotLabel = mode === 'record' ? 'Receiver screenshot' : 'Payer screenshot'
  const [amount, setAmount] = useState(String(remainingDue))
  const [date, setDate] = useState(today())
  const [method, setMethod] = useState<PaymentMethod>('UPI')
  const [note, setNote] = useState('')
  const [proofFiles, setProofFiles] = useState<Array<{ id: string; file: File; previewUrl: string }>>([])
  const [activePreview, setActivePreview] = useState<{ url: string; name: string } | null>(null)
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [closing, setClosing] = useState(false)
  const proofInputRef = useRef<HTMLInputElement>(null)
  const sheetRef = useRef<HTMLElement>(null)
  const closeTimerRef = useRef<number | null>(null)
  const previewUrlsRef = useRef(new Set<string>())
  const previewHistoryPushed = useRef(false)
  const dragStartRef = useRef({ y: 0, time: 0 })
  const dragYRef = useRef(0)
  const workingRef = useRef(false)
  const closingRef = useRef(false)

  workingRef.current = working

  function closeSheet() {
    if (closingRef.current || workingRef.current) return
    closingRef.current = true
    setClosing(true)
    setDragging(false)
    closeTimerRef.current = window.setTimeout(onClose, 160)
  }

  useBrowserBackDismiss(() => closeSheet())

  function startDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || closingRef.current || workingRef.current) return
    dragStartRef.current = { y: event.clientY, time: performance.now() }
    dragYRef.current = 0
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!dragging || closingRef.current) return
    const nextY = Math.max(0, event.clientY - dragStartRef.current.y)
    dragYRef.current = nextY
    sheetRef.current?.style.setProperty('--sheet-drag-y', `${nextY}px`)
  }

  function finishDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!dragging || closingRef.current) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const elapsed = Math.max(performance.now() - dragStartRef.current.time, 1)
    const velocity = dragYRef.current / elapsed
    if (dragYRef.current > Math.min(130, window.innerHeight * 0.16) || (dragYRef.current > 28 && velocity > 0.55)) {
      closeSheet()
      return
    }
    dragYRef.current = 0
    setDragging(false)
    sheetRef.current?.style.setProperty('--sheet-drag-y', '0px')
  }

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopImmediatePropagation()
      closeSheet()
    }
    window.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape, true)
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
      previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      previewUrlsRef.current.clear()
    }
  }, [])

  useEffect(() => {
    if (!activePreview) return
    window.history.pushState({ ...window.history.state, tallyBackScreenshot: true }, '', window.location.href)
    previewHistoryPushed.current = true
    const closeOnBack = () => {
      previewHistoryPushed.current = false
      setActivePreview(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      closePreview()
    }
    window.addEventListener('popstate', closeOnBack)
    window.addEventListener('keydown', closeOnEscape, true)
    return () => {
      window.removeEventListener('popstate', closeOnBack)
      window.removeEventListener('keydown', closeOnEscape, true)
      if (previewHistoryPushed.current && window.history.state?.tallyBackScreenshot) {
        previewHistoryPushed.current = false
        window.history.back()
      }
    }
  }, [activePreview])

  function closePreview() {
    if (previewHistoryPushed.current && window.history.state?.tallyBackScreenshot) {
      window.history.back()
      return
    }
    previewHistoryPushed.current = false
    setActivePreview(null)
  }

  function addProofFiles(event: ChangeEvent<HTMLInputElement>) {
    const incoming = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    if (!incoming.length) return

    const existingKeys = new Set(proofFiles.map(({ file }) => `${file.name}:${file.size}:${file.lastModified}`))
    const accepted: File[] = []
    let validationError = ''
    incoming.forEach((file) => {
      const key = `${file.name}:${file.size}:${file.lastModified}`
      if (!acceptedScreenshotTypes.includes(file.type)) {
        validationError = 'Use PNG, JPG, or WebP screenshots.'
        return
      }
      if (file.size > MAX_SCREENSHOT_SIZE) {
        validationError = 'Each screenshot must be 6 MB or smaller.'
        return
      }
      if (existingKeys.has(key)) return
      existingKeys.add(key)
      accepted.push(file)
    })

    const available = MAX_PAYMENT_SCREENSHOTS - proofFiles.length
    if (accepted.length > available) validationError = 'Attach only one screenshot.'
    const next = accepted.slice(0, Math.max(0, available)).map((file) => {
      const previewUrl = URL.createObjectURL(file)
      previewUrlsRef.current.add(previewUrl)
      return { id: `${file.name}-${file.size}-${file.lastModified}`, file, previewUrl }
    })
    if (next.length) setProofFiles((current) => [...current, ...next])
    setError(validationError)
  }

  function removeProof(id: string) {
    setProofFiles((current) => current.filter((proof) => {
      if (proof.id !== id) return true
      URL.revokeObjectURL(proof.previewUrl)
      previewUrlsRef.current.delete(proof.previewUrl)
      return false
    }))
    setError('')
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const numericAmount = Number(amount)
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setError('Enter payment amount greater than zero.')
      return
    }
    if (!hasValidMoneyPrecision(numericAmount)) {
      setError('Enter an amount with no more than two decimal places.')
      return
    }
    if (numericAmount > remainingDue) {
      setError(`Amount cannot exceed remaining due of ${money.format(remainingDue)}.`)
      return
    }
    if (!date) {
      setError('Choose payment date.')
      return
    }
    if (date > today()) {
      setError('Payment date cannot be in the future.')
      return
    }
    if (mode === 'request' && !proofFiles.length) {
      setError('Add at least one payer screenshot.')
      return
    }

    try {
      setWorking(true)
      setError('')
      await onSend({
        amount: numericAmount,
        method,
        paidAt: date,
        note,
        proofFiles: proofFiles.map(({ file }) => file),
      })
      onClose()
    } catch (sendError) {
      setError(actionableFirebaseError(
        sendError,
        mode === 'record'
          ? 'Payment could not be saved. Check connection and retry.'
          : 'Payment request could not be sent. Check connection and retry.',
      ))
    } finally {
      setWorking(false)
    }
  }

  return (
    <div
      className={`modal-backdrop repayment-backdrop ${closing ? 'closing' : ''}`}
      role="presentation"
      onPointerDown={(event) => { if (event.target === event.currentTarget) closeSheet() }}
    >
      <section
        ref={sheetRef}
        className={`modal-card repayment-modal ${dragging ? 'dragging' : ''} ${closing ? 'closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="repayment-title"
        style={{ '--sheet-drag-y': '0px' } as CSSProperties}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          className="add-entry-grabber"
          type="button"
          aria-label="Drag down to close record payment"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
        ><span /></button>
        <div className="modal-header repayment-header">
          <div>
            <p className="modal-kicker">{mode === 'record' ? `Paid by ${entry.borrower.name}` : 'Offline repayment'}</p>
            <h2 id="repayment-title">Record payment</h2>
          </div>
          <button className="icon-button" type="button" onClick={closeSheet} aria-label="Close dialog" disabled={working}>
            <X size={20} />
          </button>
        </div>

        <div className="repayment-summary">
          <div><span>{entry.occasion}</span><small>Remaining due</small></div>
          <strong>{money.format(remainingDue)}</strong>
        </div>

        <form onSubmit={submit}>
          <div className="repayment-fields">
            <label>
              Amount paid
              <div className="money-input">
                <span>₹</span>
                <input
                  value={amount}
                  onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))}
                  inputMode="decimal"
                  placeholder="0"
                  disabled={working}
                />
              </div>
            </label>
            <div className="form-field">
              <span>Payment date</span>
              <DatePicker value={date} onChange={setDate} max={today()} />
            </div>
            <label>
              Payment method
              <select value={method} onChange={(event) => setMethod(event.target.value as PaymentMethod)} disabled={working}>
                {methods.map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
          </div>

          <section className="repayment-proof" aria-labelledby="repayment-proof-title">
            <div className="repayment-proof-heading">
              <div>
                <strong id="repayment-proof-title">{screenshotLabel}</strong>
                <span>{mode === 'request' ? 'Required · 1 screenshot' : 'Optional · 1 screenshot maximum'} · 6 MB</span>
              </div>
              <button
                className="payment-upload-button"
                type="button"
                onClick={() => proofInputRef.current?.click()}
                disabled={working || proofFiles.length >= MAX_PAYMENT_SCREENSHOTS}
              >
                <ImagePlus size={16} /> Add screenshots
              </button>
              <input
                ref={proofInputRef}
                className="visually-hidden"
                type="file"
                accept={acceptedScreenshotTypes.join(',')}
                aria-label={`Upload ${screenshotLabel.toLowerCase()}`}
                onChange={addProofFiles}
              />
            </div>
            {proofFiles.length ? (
              <div className="repayment-preview-rail">
                {proofFiles.map((proof, index) => (
                  <figure key={proof.id} className="repayment-preview-card">
                    <button type="button" className="repayment-preview-open" onClick={() => setActivePreview({ url: proof.previewUrl, name: proof.file.name })}>
                      <img src={proof.previewUrl} alt={`${screenshotLabel} ${index + 1}`} />
                    </button>
                    <button type="button" className="repayment-preview-remove" onClick={() => removeProof(proof.id)} disabled={working}>
                      <Trash2 size={12} /> Remove
                    </button>
                  </figure>
                ))}
              </div>
            ) : null}
          </section>

          <label className="repayment-note">
            Note
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value.slice(0, 280))}
              rows={2}
              placeholder="Reference number or short note"
              disabled={working}
            />
          </label>

          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <div className="modal-actions repayment-actions">
            <button className="secondary-button" type="button" onClick={closeSheet} disabled={working}>Cancel</button>
            <button className="primary-button" type="submit" disabled={working}>
              {working ? <LoaderCircle className="spin" size={16} /> : null}
              {working
                ? mode === 'record' ? 'Saving payment…' : 'Uploading & sending…'
                : mode === 'record' ? 'Save payment' : 'Send for approval'}
            </button>
          </div>
        </form>
      </section>

      {activePreview ? createPortal(
        <div className="screenshot-lightbox" role="presentation" onPointerDown={closePreview}>
          <section role="dialog" aria-modal="true" aria-label="Payment screenshot" onPointerDown={(event) => event.stopPropagation()}>
            <img src={activePreview.url} alt={activePreview.name} />
          </section>
        </div>,
        document.body,
      ) : null}
    </div>
  )
}

function ReviewRequestModal({
  entry,
  onClose,
  onSend,
}: {
  entry: LedgerEntry
  onClose: () => void
  onSend: (draft: ReviewSubmissionDraft) => Promise<void>
}) {
  const [amount, setAmount] = useState(String(entryOriginalAmount(entry)))
  const [method, setMethod] = useState<PaymentMethod>(entry.method)
  const [occasion, setOccasion] = useState(entry.occasion)
  const [date, setDate] = useState(entry.date)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)

  useBrowserBackDismiss(() => {
    if (!working) onClose()
  })

  async function submit(event: FormEvent) {
    event.preventDefault()
    const proposedAmount = Number(amount)
    if (!Number.isFinite(proposedAmount) || proposedAmount <= 0) {
      setError('Enter the amount you believe is correct.')
      return
    }
    if (!hasValidMoneyPrecision(proposedAmount)) {
      setError('Enter an amount with no more than two decimal places.')
      return
    }
    if (proposedAmount < entryPaidAmount(entry)) {
      setError(`Amount cannot be less than ${money.format(entryPaidAmount(entry))} already approved.`)
      return
    }
    if (!occasion.trim()) {
      setError('Enter what the payment was for.')
      return
    }
    if (!date) {
      setError('Choose the correct date.')
      return
    }
    if (
      proposedAmount === entryOriginalAmount(entry)
      && method === entry.method
      && occasion.trim() === entry.occasion
      && date === entry.date
    ) {
      setError('Change at least one detail before sending for review.')
      return
    }

    try {
      setWorking(true)
      setError('')
      await onSend({
        kind: 'amount',
        proposedAmount,
        proposedMethod: method,
        proposedOccasion: occasion.trim(),
        proposedDate: date,
        note,
        proofFiles: [],
      })
      onClose()
    } catch {
      setError('Could not send this review request. Please try again.')
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal-card review-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-request-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <p className="modal-kicker">Request a correction</p>
            <h2 id="review-request-title">What needs reviewing?</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog">
            <X size={20} />
          </button>
        </div>

        <div className="review-entry-block">
          <p className="review-section-label">Due being reviewed</p>
          <div className="review-entry-context">
            <div>
              <span>{entry.occasion}</span>
              <small>Recorded by {entry.lender.name}</small>
            </div>
            <strong>{money.format(entryRemainingAmount(entry))}</strong>
          </div>
        </div>

        <form onSubmit={submit}>
          <div className="review-response-section">
            <div className="review-step-heading">
              <span>1</span>
              <div>
                <strong>Add correct details</strong>
                <small>Only changed details will be sent for review.</small>
              </div>
            </div>

            <div className="review-details-grid">
              <label className="review-detail-field">
                Amount
                <div className="money-input">
                  <span>₹</span>
                  <input
                    value={amount}
                    onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))}
                    inputMode="decimal"
                  />
                </div>
              </label>
              <label className="review-detail-field">
                Paid using
                <select value={method} onChange={(event) => setMethod(event.target.value as PaymentMethod)}>
                  {methods.map((item) => <option key={item}>{item}</option>)}
                </select>
              </label>
              <label className="review-detail-field">
                What was it for?
                <input value={occasion} onChange={(event) => setOccasion(event.target.value)} />
              </label>
              <div className="review-detail-field form-field">
                <span>Date</span>
                <DatePicker value={date} onChange={setDate} />
              </div>
            </div>

            <label className="review-field">
              Note <span>(optional)</span>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value.slice(0, 280))}
                placeholder="Explain what looks wrong…"
                rows={3}
              />
            </label>
          </div>
          {error ? <p className="form-error">{error}</p> : null}
          <div className="modal-actions">
            <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
            <button className="primary-button" type="submit" disabled={working}>{working ? 'Sending…' : 'Send for review'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

function DeleteDueModal({
  entry,
  onClose,
  onDelete,
}: {
  entry: LedgerEntry
  onClose: () => void
  onDelete: (entry: LedgerEntry) => Promise<void>
}) {
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')

  useBrowserBackDismiss(() => {
    if (!working) onClose()
  })

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      setWorking(true)
      setError('')
      await onDelete(entry)
    } catch {
      setError('Could not delete this due. Check connection and try again.')
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!working) onClose() }}>
      <section className="modal-card delete-due-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-due-title" aria-describedby="delete-due-description" onMouseDown={(event) => event.stopPropagation()}>
        <span className="delete-warning-icon" aria-hidden="true"><AlertTriangle size={22} /></span>
        <h2 id="delete-due-title">Delete this due?</h2>
        <p id="delete-due-description">This removes it from both ledgers. This cannot be undone.</p>
        <div className="delete-due-context">
          <span>{entry.occasion}</span>
          <strong>{money.format(entry.amount)}</strong>
          <small>{entry.borrower.name} · {shortDate.format(new Date(`${entry.date}T00:00:00`))}</small>
        </div>
        <form onSubmit={submit}>
          {error ? <p className="form-error">{error}</p> : null}
          <div className="modal-actions">
            <button className="secondary-button" type="button" onClick={onClose} disabled={working}>Keep due</button>
            <button className="danger-button" type="submit" disabled={working}>{working ? 'Deleting…' : 'Delete'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

function DeleteContactModal({
  person,
  onClose,
  onDelete,
}: {
  person: Person
  onClose: () => void
  onDelete: (person: Person) => Promise<void>
}) {
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')

  useBrowserBackDismiss(() => {
    if (!working) onClose()
  })

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      setWorking(true)
      setError('')
      await onDelete(person)
    } catch (deleteError) {
      setError((deleteError as Error).message || 'Could not delete this contact. Check connection and try again.')
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!working) onClose() }}>
      <section className="modal-card delete-due-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-contact-title" aria-describedby="delete-contact-description" onMouseDown={(event) => event.stopPropagation()}>
        <span className="delete-warning-icon" aria-hidden="true"><AlertTriangle size={22} /></span>
        <h2 id="delete-contact-title">Delete {person.name}?</h2>
        <p id="delete-contact-description">This removes the saved contact. Paid history remains in Activity. This cannot be undone.</p>
        <form onSubmit={submit}>
          {error ? <p className="form-error">{error}</p> : null}
          <div className="modal-actions">
            <button className="secondary-button" type="button" onClick={onClose} disabled={working}>Keep contact</button>
            <button className="danger-button" type="submit" disabled={working}>{working ? 'Deleting…' : 'Delete contact'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

function RepaymentRequestCard({
  request,
  direction,
  remainingAmount,
  resolving,
  onResolve,
}: {
  request: RepaymentRequest
  direction: Direction
  remainingAmount?: number
  resolving: boolean
  onResolve: (request: RepaymentRequest, decision: 'accepted' | 'rejected') => void
}) {
  const lenderRecorded = request.recordedBy === 'lender'
  const statusLabel = lenderRecorded
    ? 'Recorded'
    : request.status === 'pending' ? 'Pending approval' : request.status === 'accepted' ? 'Accepted' : 'Rejected'
  const needsAction = request.status === 'pending' && direction === 'receivable'
  const unavailableReason = needsAction && remainingAmount !== undefined
    ? remainingAmount <= 0
      ? 'This due is already paid. Reject this outstanding request.'
      : request.amount > remainingAmount
        ? `Only ${money.format(remainingAmount)} remains. Reject this request and ask for a corrected amount.`
        : ''
    : ''
  const [expanded, setExpanded] = useState(false)
  return (
    <article className={`repayment-request-card ${request.status}`}>
      <button
        className="transaction-disclosure-toggle"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        <span className="transaction-disclosure-copy">
          <strong>{lenderRecorded ? `${request.payerName} paid` : request.payerName}</strong>
          <small>{request.method} · {shortDate.format(new Date(`${request.paidAt}T00:00:00`))}</small>
        </span>
        <span className="transaction-disclosure-value">
          <strong>{money.format(request.amount)}</strong>
          <span className={`repayment-status ${request.status}`}>{statusLabel}</span>
        </span>
        <ChevronDown className={expanded ? 'expanded' : ''} size={15} aria-hidden="true" />
      </button>
      {expanded ? (
        <div className="transaction-disclosure-body">
          <div className="repayment-request-details">
            <span><CalendarDays size={13} /> {lenderRecorded ? 'Recorded' : 'Submitted'} {dateTime.format(new Date(timestampMillis(request.createdAt)))}</span>
          </div>
          {request.note ? <p>{request.note}</p> : null}
          {request.proofScreenshots.length ? (
            <PaymentScreenshotGallery
              screenshots={request.proofScreenshots}
              label={lenderRecorded ? 'Receiver screenshot' : 'Payer screenshot'}
              compact
            />
          ) : null}
          {needsAction ? (
            <>
              {unavailableReason ? <small className="repayment-waiting">{unavailableReason}</small> : null}
              <div className="repayment-review-actions">
                <button type="button" className="repayment-reject" disabled={resolving} onClick={() => onResolve(request, 'rejected')}>
                  Reject
                </button>
                <button type="button" className="repayment-accept" disabled={resolving || Boolean(unavailableReason)} onClick={() => onResolve(request, 'accepted')}>
                  {resolving ? 'Reviewing…' : 'Accept payment'}
                </button>
              </div>
            </>
          ) : request.status === 'pending' ? (
            <small className="repayment-waiting">Waiting for lender approval.</small>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function ReviewHistoryCard({ review }: { review: LedgerReviewRecord }) {
  const status = review.status === 'approved' ? 'accepted' : review.status
  const [expanded, setExpanded] = useState(false)
  return (
    <article className={`review-history-card ${status}`}>
      <button
        className="transaction-disclosure-toggle"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        <span className="transaction-disclosure-copy">
          <strong>{review.kind === 'paid' ? 'Already paid review' : 'Correction review'}</strong>
          <small>{shortDate.format(new Date(`${review.proposedDate}T00:00:00`))}</small>
        </span>
        <span className={`repayment-status ${status}`}>
          {review.status === 'approved' ? 'Accepted' : review.status === 'rejected' ? 'Rejected' : 'Pending'}
        </span>
        <ChevronDown className={expanded ? 'expanded' : ''} size={15} aria-hidden="true" />
      </button>
      {expanded ? (
        <div className="transaction-disclosure-body">
          <p>{review.note || (review.kind === 'paid' ? 'Payer screenshot submitted.' : 'Due details reviewed.')}</p>
          {review.proofScreenshots.length ? (
            <PaymentScreenshotGallery
              screenshots={review.proofScreenshots}
              label={review.kind === 'paid' ? 'Payer screenshot' : 'Review screenshot'}
              compact
            />
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function EntryTransactionHistory({
  repayments,
  reviews,
  direction,
  onResolveRepayment,
}: {
  repayments: RepaymentRequest[]
  reviews: LedgerReviewRecord[]
  direction: Direction
  onResolveRepayment: (request: RepaymentRequest, decision: 'accepted' | 'rejected') => void
}) {
  const [expanded, setExpanded] = useState(false)
  const items = [
    ...repayments.map((repayment) => ({
      id: `repayment-${repayment.id}`,
      kind: 'repayment' as const,
      timestamp: timestampMillis(repayment.reviewedAt ?? repayment.createdAt),
      repayment,
    })),
    ...reviews.map((review) => ({
      id: `review-${review.id}`,
      kind: 'review' as const,
      timestamp: timestampMillis(review.resolvedAt ?? review.updatedAt ?? review.createdAt),
      review,
    })),
  ].sort((a, b) => b.timestamp - a.timestamp)

  if (!items.length) return null

  const latest = items[0]
  const latestStatus = latest.kind === 'repayment'
    ? latest.repayment.status === 'accepted' ? 'accepted' : 'rejected'
    : latest.review.status === 'approved' ? 'accepted' : 'rejected'

  return (
    <section className="entry-transaction-history" aria-label="Transaction history">
      <button
        className="transaction-history-toggle"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        <span className="transaction-history-icon"><History size={14} /></span>
        <span>
          <strong>Transaction history</strong>
          <small>{items.length} {items.length === 1 ? 'record' : 'records'} · latest {latestStatus}</small>
        </span>
        <span className="transaction-history-count">{items.length}</span>
        <ChevronDown className={expanded ? 'expanded' : ''} size={16} aria-hidden="true" />
      </button>
      {expanded ? (
        <div className="transaction-history-list">
          {items.map((item) => item.kind === 'repayment' ? (
            <RepaymentRequestCard
              key={item.id}
              request={item.repayment}
              direction={direction}
              resolving={false}
              onResolve={onResolveRepayment}
            />
          ) : <ReviewHistoryCard key={item.id} review={item.review} />)}
        </div>
      ) : null}
    </section>
  )
}

export function OpenDueCard({
  entry,
  direction,
  expanded,
  review,
  repayments,
  reviews,
  resolvingReviewId,
  resolvingRepaymentId,
  onEditDue,
  onDeleteDue,
  onOpenSplit,
  onRequestReview,
  onResolveReview,
  onRecordPayment,
  onResolveRepayment,
  onToggle,
}: {
  entry: LedgerEntry
  direction: Direction
  expanded: boolean
  review?: LedgerReview
  repayments: RepaymentRequest[]
  reviews: LedgerReviewRecord[]
  resolvingReviewId: string | null
  resolvingRepaymentId: string | null
  onEditDue: (entry: LedgerEntry) => void
  onDeleteDue: (entry: LedgerEntry) => void
  onOpenSplit: () => void
  onRequestReview: (entry: LedgerEntry) => void
  onResolveReview: (review: LedgerReview, entry: LedgerEntry, decision: 'approved' | 'rejected') => void
  onRecordPayment: (entry: LedgerEntry) => void
  onResolveRepayment: (request: RepaymentRequest, decision: 'accepted' | 'rejected') => void
  onToggle: () => void
}) {
  const cardRef = useRef<HTMLElement>(null)
  const Icon = methodIcons[entry.method]
  const splitReference = getSplitLedgerReference(entry.id)
  const pendingRepayments = repayments.filter((request) => request.status === 'pending')
  const completedRepayments = repayments.filter((request) => request.status !== 'pending')
  const completedReviews = reviews.filter((item) => item.status !== 'pending')
  const remainingAmount = entryRemainingAmount(entry)
  const originalAmount = entryOriginalAmount(entry)
  const partiallyPaid = canonicalEntryStatus(entry) === 'partially_paid'
  const attentionCount = pendingRepayments.length + (review ? 1 : 0)
  const historyCount = completedRepayments.length + completedReviews.length
  const hasHistory = Boolean(entry.historyStarted || review || repayments.length || reviews.length)

  useEffect(() => {
    if (!expanded) return
    const scrollCardIntoView = () => {
      const card = cardRef.current
      const scrollContainer = card?.closest('.drawer-entries')
      if (!(card instanceof HTMLElement) || !(scrollContainer instanceof HTMLElement)) return
      if (typeof scrollContainer.scrollTo !== 'function') return
      const cardRect = card.getBoundingClientRect()
      const containerRect = scrollContainer.getBoundingClientRect()
      const viewportTop = containerRect.top + 8
      const viewportBottom = containerRect.bottom - 8
      const availableHeight = viewportBottom - viewportTop
      let nextScrollTop = scrollContainer.scrollTop

      if (cardRect.height > availableHeight || cardRect.top < viewportTop) {
        nextScrollTop += cardRect.top - viewportTop
      } else if (cardRect.bottom > viewportBottom) {
        nextScrollTop += cardRect.bottom - viewportBottom
      }

      const reduceMotion = typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      scrollContainer.scrollTo({
        top: Math.max(0, nextScrollTop),
        behavior: reduceMotion ? 'auto' : 'smooth',
      })
    }

    const animationFrame = window.requestAnimationFrame(scrollCardIntoView)
    const pendingImages = Array.from(cardRef.current?.querySelectorAll('img') ?? [])
      .filter((image) => !image.complete)
    pendingImages.forEach((image) => image.addEventListener('load', scrollCardIntoView, { once: true }))

    return () => {
      window.cancelAnimationFrame(animationFrame)
      pendingImages.forEach((image) => image.removeEventListener('load', scrollCardIntoView))
    }
  }, [expanded])

  return (
    <article ref={cardRef} className={`drawer-entry due-card ${expanded ? 'is-expanded' : ''} ${partiallyPaid ? 'drawer-entry-partial' : ''}`}>
      <button
        className="due-summary"
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="method-icon"><Icon size={17} /></span>
        <span className="drawer-entry-copy">
          <strong>{entry.occasion}</strong>
          <small>{splitReference ? 'Split · ' : ''}{entry.method} · {shortDate.format(new Date(`${entry.date}T00:00:00`))}{direction === 'payable' ? ` · ${entry.lender.name}` : ''}</small>
          {attentionCount || historyCount ? (
            <span className="due-summary-flags">
              {attentionCount ? <b className="attention">{attentionCount} needs review</b> : null}
              {historyCount ? <b className="history">{historyCount} in history</b> : null}
            </span>
          ) : null}
        </span>
        <span className="drawer-entry-balance">
          <strong className="drawer-entry-amount">{money.format(remainingAmount)}</strong>
          {partiallyPaid ? <small>{money.format(entryPaidAmount(entry))} of {money.format(originalAmount)} paid</small> : null}
        </span>
        <ChevronDown className={expanded ? 'expanded' : ''} size={17} aria-hidden="true" />
      </button>

      {expanded ? (
        <div className="due-card-details">
          {entry.screenshots?.length ? <PaymentScreenshotGallery screenshots={entry.screenshots} label="Receiver screenshot" compact /> : null}
          {review ? (
            <div className={`entry-review ${direction}`}>
              <div>
                <span className="review-status"><Flag size={13} /> Review pending</span>
                <strong>
                  {review.kind === 'amount'
                    ? `${entry.borrower.name} requested changes to this due.`
                    : `${entry.borrower.name} says this has already been paid.`}
                </strong>
                {review.note ? <p>“{review.note}”</p> : null}
                {review.proofScreenshots?.length ? (
                  <PaymentScreenshotGallery screenshots={review.proofScreenshots} label="Payer screenshot" compact />
                ) : null}
              </div>
              {direction === 'receivable' ? (
                <div className="review-actions">
                  <button type="button" disabled={resolvingReviewId === entry.id} onClick={() => onResolveReview(review, entry, 'rejected')}>Keep as is</button>
                  <button type="button" disabled={resolvingReviewId === entry.id} onClick={() => onResolveReview(review, entry, 'approved')}>
                    {review.kind === 'amount' ? 'Apply changes' : 'Confirm paid'}
                  </button>
                </div>
              ) : <small>Waiting for {entry.lender.name} to review this.</small>}
            </div>
          ) : null}
          {pendingRepayments.length ? (
            <div className="entry-repayment-list">
              {pendingRepayments.map((request) => (
                <RepaymentRequestCard
                  key={request.id}
                  request={request}
                  direction={direction}
                  remainingAmount={remainingAmount}
                  resolving={resolvingRepaymentId === request.id}
                  onResolve={onResolveRepayment}
                />
              ))}
            </div>
          ) : null}
          <EntryTransactionHistory
            repayments={completedRepayments}
            reviews={completedReviews}
            direction={direction}
            onResolveRepayment={onResolveRepayment}
          />
          {direction === 'receivable' ? (
            <div className="drawer-entry-actions">
              {!review && !pendingRepayments.length ? (
                <button className="entry-action paid-claim" type="button" onClick={() => onRecordPayment(entry)}><Banknote size={16} /> Record payment</button>
              ) : null}
              {splitReference
                ? SPLITS_ENABLED ? <button className="entry-split-action" type="button" onClick={onOpenSplit}><Split size={15} /> Manage split</button> : null
                : <>
                    {!review && !pendingRepayments.length ? <button className="entry-edit-action" type="button" onClick={() => onEditDue(entry)} aria-label={`Edit ${entry.occasion} due`}><Pencil size={15} /> Edit</button> : null}
                    {!hasHistory ? <button className="entry-delete-action" type="button" onClick={() => onDeleteDue(entry)} aria-label={`Delete ${entry.occasion} due`}><Trash2 size={15} /> Delete</button> : null}
                  </>}
            </div>
          ) : (
            <div className="drawer-entry-actions payer-actions">
              {!review && !pendingRepayments.length ? <button className="entry-action paid-claim" type="button" onClick={() => onRecordPayment(entry)}><CheckCircle2 size={15} /> Record payment</button> : null}
              {!review && !pendingRepayments.length ? <button className="entry-action report" type="button" onClick={() => onRequestReview(entry)}><Flag size={15} /> Report issue</button> : null}
            </div>
          )}
        </div>
      ) : null}
    </article>
  )
}

function PersonDrawer({
  summary,
  direction,
  pendingReviews,
  repaymentRequests,
  reviewHistory,
  resolvingReviewId,
  resolvingRepaymentId,
  onClose,
  onAddDue,
  onEditDue,
  onDeleteContact,
  onDeleteDue,
  onOpenSplit,
  onRequestReview,
  onResolveReview,
  onRecordPayment,
  onResolveRepayment,
}: {
  summary: ContactSummary
  direction: Direction
  pendingReviews: Map<string, LedgerReview>
  repaymentRequests: Map<string, RepaymentRequest[]>
  reviewHistory: Map<string, LedgerReviewRecord[]>
  resolvingReviewId: string | null
  resolvingRepaymentId: string | null
  onClose: () => void
  onAddDue: (person: Person) => void
  onEditDue: (entry: LedgerEntry) => void
  onDeleteContact: (person: Person) => void
  onDeleteDue: (entry: LedgerEntry) => void
  onOpenSplit: () => void
  onRequestReview: (entry: LedgerEntry) => void
  onResolveReview: (review: LedgerReview, entry: LedgerEntry, decision: 'approved' | 'rejected') => void
  onRecordPayment: (entry: LedgerEntry) => void
  onResolveRepayment: (request: RepaymentRequest, decision: 'accepted' | 'rejected') => void
}) {
  const openDueEntries = summary.entries
    .filter((entry) => !isPaidEntry(entry))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
  const paidDueEntries = summary.entries
    .filter(isPaidEntry)
    .sort((a, b) => (
      (b.settledAt ?? `${b.date}T00:00:00`).localeCompare(a.settledAt ?? `${a.date}T00:00:00`)
      || b.id.localeCompare(a.id)
    ))
  const firstName = summary.person.name.split(' ')[0]
  const sheetRef = useRef<HTMLElement>(null)
  const closeTimerRef = useRef<number | null>(null)
  const dragStartRef = useRef({ y: 0, time: 0 })
  const dragYRef = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [closing, setClosing] = useState(false)
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null)
  const [paidExpanded, setPaidExpanded] = useState(false)

  function closeSheet() {
    if (closing) return
    setClosing(true)
    setDragging(false)
    closeTimerRef.current = window.setTimeout(onClose, 160)
  }

  useBrowserBackDismiss(() => closeSheet())

  function startDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || closing) return
    dragStartRef.current = { y: event.clientY, time: performance.now() }
    dragYRef.current = 0
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!dragging || closing) return
    const nextDragY = Math.max(0, event.clientY - dragStartRef.current.y)
    dragYRef.current = nextDragY
    sheetRef.current?.style.setProperty('--sheet-drag-y', `${nextDragY}px`)
  }

  function finishDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!dragging || closing) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const elapsed = Math.max(performance.now() - dragStartRef.current.time, 1)
    const velocity = dragYRef.current / elapsed
    if (dragYRef.current > Math.min(130, window.innerHeight * 0.16) || (dragYRef.current > 28 && velocity > 0.55)) {
      closeSheet()
      return
    }
    dragYRef.current = 0
    setDragging(false)
    sheetRef.current?.style.setProperty('--sheet-drag-y', '0px')
  }

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    sheetRef.current?.focus()

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSheet()
    }
    window.addEventListener('keydown', closeOnEscape)

    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    }
  }, [])

  return (
    <div className={`drawer-backdrop ${closing ? 'closing' : ''}`} onPointerDown={(event) => { if (event.target === event.currentTarget) closeSheet() }} role="presentation">
      <aside
        ref={sheetRef}
        className={`person-drawer ${dragging ? 'dragging' : ''} ${closing ? 'closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="person-ledger-title"
        tabIndex={-1}
        style={{ '--sheet-drag-y': '0px' } as CSSProperties}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          className="drawer-grabber"
          type="button"
          aria-label="Drag down to close details"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
        ><span /></button>
        <header className="drawer-topbar">
          <button className="drawer-back" onClick={closeSheet} aria-label="Close details"><X size={18} /></button>
          <div className="drawer-person-title">
            <Avatar person={summary.person} size="sm" />
            <span className="drawer-person-copy">
              <strong id="person-ledger-title">{summary.person.name}</strong>
              <small>{formatPhone(summary.person.phone)}</small>
            </span>
          </div>
          {direction === 'receivable' ? (
            <div className="drawer-topbar-actions">
              {summary.openCount ? (
                <button className="drawer-quick-add" type="button" onClick={() => onAddDue(summary.person)} aria-label={`Add due for ${summary.person.name}`}>
                  <Plus size={16} /> Add due
                </button>
              ) : null}
              {!summary.openCount ? (
                <button
                  className="drawer-delete-contact"
                  type="button"
                  onClick={() => onDeleteContact(summary.person)}
                  aria-label={`Delete ${summary.person.name}`}
                  title="Delete contact"
                >
                  <Trash2 size={17} />
                </button>
              ) : null}
            </div>
          ) : <span className="drawer-topbar-spacer" aria-hidden="true" />}
        </header>
        <div className="drawer-entries">
          <div className="drawer-section-title">
            <div>
              <h3>{direction === 'receivable' ? `Payments expected from ${firstName}` : `Payments expected by ${firstName}`}</h3>
            </div>
            <span>{summary.openCount}</span>
          </div>
          {!summary.openCount ? (
            <div className={`drawer-empty-ledger ${direction === 'receivable' ? 'receivable-empty' : ''}`}>
              {direction === 'receivable' ? (
                <button className="drawer-quick-add drawer-empty-add" type="button" onClick={() => onAddDue(summary.person)} aria-label={`Add due for ${summary.person.name}`}>
                  <Plus size={16} /> Add due
                </button>
              ) : (
                <>
                  <ReceiptText size={21} />
                  <strong>No dues yet</strong>
                  <span>New dues assigned to you appear here.</span>
                </>
              )}
            </div>
          ) : null}
          <div className="drawer-entry-list">
            {openDueEntries.map((entry) => (
              <OpenDueCard
                key={entry.id}
                entry={entry}
                direction={direction}
                expanded={expandedEntryId === entry.id}
                review={pendingReviews.get(entry.id)}
                repayments={repaymentRequests.get(entry.id) ?? []}
                reviews={reviewHistory.get(entry.id) ?? []}
                resolvingReviewId={resolvingReviewId}
                resolvingRepaymentId={resolvingRepaymentId}
                onEditDue={onEditDue}
                onDeleteDue={onDeleteDue}
                onOpenSplit={onOpenSplit}
                onRequestReview={onRequestReview}
                onResolveReview={onResolveReview}
                onRecordPayment={onRecordPayment}
                onResolveRepayment={onResolveRepayment}
                onToggle={() => setExpandedEntryId((current) => current === entry.id ? null : entry.id)}
              />
            ))}
          </div>
          {paidDueEntries.length ? (
            <section className="drawer-paid-history" aria-labelledby="paid-dues-title">
              <button
                className="drawer-section-title drawer-paid-title paid-history-toggle"
                type="button"
                aria-expanded={paidExpanded}
                onClick={() => setPaidExpanded((open) => !open)}
              >
                <div>
                  <h3 id="paid-dues-title">
                    {direction === 'receivable'
                      ? `Payments already received from ${firstName}`
                      : `Payments already sent to ${firstName}`}
                  </h3>
                </div>
                <span>{paidDueEntries.length}</span>
                <ChevronDown className={paidExpanded ? 'expanded' : ''} size={17} aria-hidden="true" />
              </button>
              {paidExpanded ? <div className="drawer-entry-list">
                {paidDueEntries.map((entry) => {
                  const Icon = methodIcons[entry.method]
                  const splitReference = getSplitLedgerReference(entry.id)
                  const entryRepayments = repaymentRequests.get(entry.id) ?? []
                  const entryReviews = reviewHistory.get(entry.id) ?? []
                  const pendingRepayments = entryRepayments.filter((request) => request.status === 'pending')
                  const completedRepayments = entryRepayments.filter((request) => request.status !== 'pending')
                  const completedReviews = entryReviews.filter((item) => item.status !== 'pending')
                  return (
                    <article className="drawer-entry drawer-entry-paid" key={entry.id}>
                      <span className="method-icon"><Icon size={17} /></span>
                      <div className="drawer-entry-copy">
                        <h4>{entry.occasion}</h4>
                        <p>{splitReference ? 'Split · ' : ''}{entry.method} · {shortDate.format(new Date(`${entry.date}T00:00:00`))}{direction === 'payable' ? ` · Recorded by ${entry.lender.name}` : ''}</p>
                      </div>
                      <div className="drawer-paid-amount">
                        <strong className="drawer-entry-amount">{money.format(entryOriginalAmount(entry))}</strong>
                        <span className="drawer-paid-status"><CheckCircle2 size={12} /> Paid</span>
                      </div>
                      {entry.screenshots?.length ? (
                        <PaymentScreenshotGallery screenshots={entry.screenshots} label="Receiver screenshot" compact />
                      ) : null}
                      {pendingRepayments.length ? (
                        <div className="entry-repayment-list">
                          {pendingRepayments.map((request) => (
                            <RepaymentRequestCard
                              key={request.id}
                              request={request}
                              direction={direction}
                              remainingAmount={0}
                              resolving={resolvingRepaymentId === request.id}
                              onResolve={onResolveRepayment}
                            />
                          ))}
                        </div>
                      ) : null}
                      <EntryTransactionHistory
                        repayments={completedRepayments}
                        reviews={completedReviews}
                        direction={direction}
                        onResolveRepayment={onResolveRepayment}
                      />
                    </article>
                  )
                })}
              </div> : null}
            </section>
          ) : null}
        </div>
      </aside>
    </div>
  )
}

function TallyBackApp() {
  const [currentUser, setCurrentUser] = useState<Person | null>(null)
  const [entries, setEntries] = useState<LedgerEntry[]>([])
  const [contacts, setContacts] = useState<SavedContact[]>([])
  const [authLoading, setAuthLoading] = useState(isFirebaseConfigured)
  const [dataLoading, setDataLoading] = useState(false)
  const [contactsLoading, setContactsLoading] = useState(false)
  const [direction, setDirection] = useState<Direction>('receivable')
  const [view, setView] = useState<View>('ledger')
  const [search, setSearch] = useState('')
  const [showAddPerson, setShowAddPerson] = useState(false)
  const [addDuePerson, setAddDuePerson] = useState<Person | null>(null)
  const [editEntryTarget, setEditEntryTarget] = useState<LedgerEntry | null>(null)
  const [importingContacts, setImportingContacts] = useState(false)
  const [reviewIntent, setReviewIntent] = useState<LedgerEntry | null>(null)
  const [reviewRecords, setReviewRecords] = useState<LedgerReviewRecord[]>([])
  const [repaymentIntent, setRepaymentIntent] = useState<{ entry: LedgerEntry; mode: 'request' | 'record' } | null>(null)
  const [repaymentRequests, setRepaymentRequests] = useState<RepaymentRequest[]>([])
  const [activities, setActivities] = useState<LedgerActivity[]>([])
  const [deleteEntryTarget, setDeleteEntryTarget] = useState<LedgerEntry | null>(null)
  const [deleteContactTarget, setDeleteContactTarget] = useState<Person | null>(null)
  const [resolvingReviewId, setResolvingReviewId] = useState<string | null>(null)
  const [resolvingRepaymentId, setResolvingRepaymentId] = useState<string | null>(null)
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null)
  const [toast, setToast] = useState('')
  const [profileOpen, setProfileOpen] = useState(false)
  const profileMenuRef = useRef<HTMLDivElement>(null)
  const ledgerGridRef = useRef<HTMLDivElement>(null)
  const pullStartYRef = useRef<number | null>(null)
  const pullDistanceRef = useRef(0)
  const [pullDistance, setPullDistance] = useState(0)
  const [pullRefreshing, setPullRefreshing] = useState(false)
  const authSyncVersion = useRef(0)
  const contactPickerAvailable = canPickDeviceContacts()

  useEffect(() => {
    const ledgerGrid = ledgerGridRef.current
    if (view !== 'ledger') return
    if (!ledgerGrid) return
    const activeLedgerGrid = ledgerGrid

    function resetPull() {
      pullStartYRef.current = null
      pullDistanceRef.current = 0
      setPullDistance(0)
    }

    function handleTouchStart(event: TouchEvent) {
      if (pullRefreshing || activeLedgerGrid.scrollTop > 0 || event.touches.length !== 1) return
      pullStartYRef.current = event.touches[0].clientY
      pullDistanceRef.current = 0
    }

    function handleTouchMove(event: TouchEvent) {
      if (pullRefreshing || pullStartYRef.current === null || event.touches.length !== 1) return
      if (activeLedgerGrid.scrollTop > 0) {
        resetPull()
        return
      }

      const movement = event.touches[0].clientY - pullStartYRef.current
      if (movement <= 0) {
        pullDistanceRef.current = 0
        setPullDistance(0)
        return
      }

      event.preventDefault()
      const dampedDistance = Math.min(78, movement * 0.42)
      pullDistanceRef.current = dampedDistance
      setPullDistance(dampedDistance)
    }

    function handleTouchEnd() {
      if (pullRefreshing || pullStartYRef.current === null) return
      const shouldRefresh = pullDistanceRef.current >= 52
      pullStartYRef.current = null
      pullDistanceRef.current = 0

      if (!shouldRefresh) {
        setPullDistance(0)
        return
      }

      setPullRefreshing(true)
      setPullDistance(40)
      window.setTimeout(() => window.location.reload(), 180)
    }

    ledgerGrid.addEventListener('touchstart', handleTouchStart, { passive: true })
    ledgerGrid.addEventListener('touchmove', handleTouchMove, { passive: false })
    ledgerGrid.addEventListener('touchend', handleTouchEnd, { passive: true })
    ledgerGrid.addEventListener('touchcancel', resetPull, { passive: true })

    return () => {
      ledgerGrid.removeEventListener('touchstart', handleTouchStart)
      ledgerGrid.removeEventListener('touchmove', handleTouchMove)
      ledgerGrid.removeEventListener('touchend', handleTouchEnd)
      ledgerGrid.removeEventListener('touchcancel', resetPull)
    }
  }, [view])

  useEffect(() => {
    if (!auth) {
      setAuthLoading(false)
      return
    }
    const currentAuth = auth

    return onAuthStateChanged(currentAuth, async (firebaseUser) => {
      const syncVersion = ++authSyncVersion.current
      if (!firebaseUser) {
        setCurrentUser(null)
        setAuthLoading(false)
        return
      }

      try {
        await ensureTruecallerLedgerClaim(firebaseUser)
        const authenticatedPhone = await getAuthenticatedPhone(firebaseUser)
        const profile = await getUserProfile(firebaseUser.uid)
        if (syncVersion !== authSyncVersion.current || currentAuth.currentUser?.uid !== firebaseUser.uid) return
        const matchingProfile = profile
          && authenticatedPhone
          && toE164(profile.phone) === authenticatedPhone
          ? profile
          : null
        setCurrentUser(matchingProfile ? { ...matchingProfile, phone: authenticatedPhone } : {
          name: 'My account',
          phone: authenticatedPhone,
        })
      } catch (error) {
        console.error('[auth/profile]', error)
        if (syncVersion !== authSyncVersion.current || currentAuth.currentUser?.uid !== firebaseUser.uid) return
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

    const firebaseAuth = auth
    if (!firebaseAuth?.currentUser || !isFirebaseConfigured) return

    setDataLoading(true)
    return subscribeToEntries(
      currentUser.phone,
      (cloudEntries) => {
        setEntries(cloudEntries)
        setDataLoading(false)
      },
      (error) => {
        console.error('[ledger/listener]', {
          code: (error as { code?: string }).code,
          message: error.message,
          phone: toE164(currentUser.phone),
          uid: firebaseAuth.currentUser?.uid,
        })
        setDataLoading(false)
        setToast('Could not sync your ledger. Check the Firebase setup and try again.')
      },
    )
  }, [currentUser])

  useEffect(() => {
    const firebaseUser = auth?.currentUser
    if (!currentUser || !firebaseUser || !isFirebaseConfigured) {
      setRepaymentRequests([])
      return
    }

    return subscribeToRepaymentRequests(
      currentUser.phone,
      setRepaymentRequests,
      (error) => {
        console.error('[repayments/listener]', error)
        setToast('Could not sync repayment requests. Refresh and retry.')
      },
    )
  }, [currentUser])

  useEffect(() => {
    const firebaseUser = auth?.currentUser
    if (!currentUser || !firebaseUser || !isFirebaseConfigured) {
      setActivities([])
      return
    }

    return subscribeToActivities(
      currentUser.phone,
      setActivities,
      (error) => console.error('[activity/listener]', error),
    )
  }, [currentUser])

  useEffect(() => {
    const firebaseUser = auth?.currentUser
    if (!currentUser || !firebaseUser || !isFirebaseConfigured) {
      setContacts([])
      return
    }

    setContactsLoading(true)
    return subscribeToContacts(
      firebaseUser.uid,
      (savedContacts) => {
        setContacts(savedContacts)
        setContactsLoading(false)
      },
      (error) => {
        console.error('[contacts/listener]', error)
        setContactsLoading(false)
        setToast('Could not sync saved contacts. Refresh and try again.')
      },
    )
  }, [currentUser])

  useEffect(() => {
    const firebaseUser = auth?.currentUser
    if (!currentUser || !firebaseUser || !isFirebaseConfigured) {
      setReviewRecords([])
      return
    }

    return subscribeToReviewRecords(
      currentUser.phone,
      setReviewRecords,
      (error) => console.error('[reviews/listener]', error),
    )
  }, [currentUser])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 3200)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!profileOpen) return
    const closeOutsideProfile = (event: PointerEvent) => {
      if (!profileMenuRef.current?.contains(event.target as Node)) setProfileOpen(false)
    }
    document.addEventListener('pointerdown', closeOutsideProfile)
    return () => document.removeEventListener('pointerdown', closeOutsideProfile)
  }, [profileOpen])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowAddPerson(false)
        setAddDuePerson(null)
        setEditEntryTarget(null)
        setReviewIntent(null)
        setRepaymentIntent(null)
        setDeleteEntryTarget(null)
        setDeleteContactTarget(null)
        setProfileOpen(false)
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [])

  const userPhone = normalizePhone(currentUser?.phone ?? '')
  const ledgerTotals = useMemo(() => outstandingTotals(entries, userPhone), [entries, userPhone])
  const relevantEntries = useMemo(() => {
    if (!currentUser) return []
    return entries.filter((entry) =>
      direction === 'receivable'
        ? normalizePhone(entry.lender.phone) === userPhone
        : normalizePhone(entry.borrower.phone) === userPhone,
    )
  }, [currentUser, direction, entries, userPhone])

  const contactsByPhone = useMemo(
    () => new Map(contacts.map((contact) => [normalizePhone(contact.phone), contact])),
    [contacts],
  )

  const pendingReviews = useMemo(() => {
    const pending = new Map<string, LedgerReview>()
    entries.forEach((entry) => {
      if (entry.review?.status === 'pending') pending.set(entry.id, entry.review)
    })
    return pending
  }, [entries])

  const repaymentsByDue = useMemo(() => {
    const grouped = new Map<string, RepaymentRequest[]>()
    repaymentRequests.forEach((request) => {
      const current = grouped.get(request.dueId) ?? []
      current.push(request)
      grouped.set(request.dueId, current)
    })
    grouped.forEach((requests) => requests.sort((a, b) => timestampMillis(b.createdAt) - timestampMillis(a.createdAt)))
    return grouped
  }, [repaymentRequests])

  const reviewRecordsByDue = useMemo(() => {
    const grouped = new Map<string, LedgerReviewRecord[]>()
    reviewRecords.forEach((review) => {
      const current = grouped.get(review.entryId) ?? []
      current.push(review)
      grouped.set(review.entryId, current)
    })
    grouped.forEach((reviews) => reviews.sort((a, b) => timestampMillis(b.createdAt) - timestampMillis(a.createdAt)))
    return grouped
  }, [reviewRecords])

  const incomingReviewEntries = useMemo(() => entries.filter((entry) => (
    normalizePhone(entry.lender.phone) === userPhone
      && !isPaidEntry(entry)
      && pendingReviews.has(entry.id)
  )), [entries, pendingReviews, userPhone])

  const incomingRepayments = useMemo(() => repaymentRequests.filter((request) => (
    request.status === 'pending'
    && normalizePhone(request.lenderPhone) === userPhone
  )), [repaymentRequests, userPhone])

  const allSummaries = useMemo(() => {
    const grouped = new Map<string, ContactSummary>()

    if (direction === 'receivable') {
      contacts.forEach((contact) => {
        const key = normalizePhone(contact.phone)
        if (!key || key === userPhone) return
        grouped.set(key, {
          person: contact,
          total: 0,
          openCount: 0,
          pendingCount: 0,
          entries: [],
        })
      })
    }

    relevantEntries.forEach((entry) => {
      const entryPerson = direction === 'receivable' ? entry.borrower : entry.lender
      const key = normalizePhone(entryPerson.phone)
      const displayPerson = contactsByPhone.get(key) ?? entryPerson
      const existing = grouped.get(key) ?? {
        person: displayPerson,
        total: 0,
        openCount: 0,
        pendingCount: 0,
        entries: [],
      }
      existing.entries.push(entry)
      if (pendingReviews.has(entry.id)) existing.pendingCount += 1
      existing.pendingCount += (repaymentsByDue.get(entry.id) ?? []).filter((request) => request.status === 'pending').length
      const remainingAmount = entryRemainingAmount(entry)
      if (remainingAmount > 0) {
        existing.total += remainingAmount
        existing.openCount += 1
      }
      grouped.set(key, existing)
    })
    return [...grouped.values()]
      .filter((summary) => (
        direction === 'receivable'
          ? contactsByPhone.has(normalizePhone(summary.person.phone)) || summary.entries.length > 0
          : summary.entries.length > 0
      ))
      .sort((a, b) => b.total - a.total || a.person.name.localeCompare(b.person.name))
  }, [contacts, contactsByPhone, direction, pendingReviews, relevantEntries, repaymentsByDue, userPhone])

  const summaries = useMemo(() => {
    const queryText = search.trim().toLowerCase()
    if (!queryText) return allSummaries
    return allSummaries.filter((summary) => (
      summary.person.name.toLowerCase().includes(queryText)
      || normalizePhone(summary.person.phone).includes(queryText.replace(/\D/g, ''))
    ))
  }, [allSummaries, search])

  const selectedSummary = allSummaries.find((item) => normalizePhone(item.person.phone) === selectedPhone)

  const activityItems = useMemo<ActivityItem[]>(() => {
    const items: ActivityItem[] = []
    const explicitKeys = new Set<string>()

    activities.forEach((activity) => {
      const belongsToDirection = direction === 'receivable'
        ? normalizePhone(activity.lenderPhone) === userPhone
        : normalizePhone(activity.borrowerPhone) === userPhone
      if (!belongsToDirection) return
      explicitKeys.add(`${activity.type}:${activity.sourceId}`)
      items.push({
        id: `activity-${activity.id}`,
        timestamp: timestampMillis(activity.occurredAt),
        kind: 'activity',
        activity,
      })
    })

    relevantEntries.forEach((entry) => {
      if (explicitKeys.has(`due_created:${entry.id}`)) return
      items.push({
        id: `entry-${entry.id}`,
        timestamp: timestampMillis(entry.createdAt ?? entry.settledAt ?? `${entry.date}T00:00:00`),
        kind: 'entry',
        entry,
      })
    })

    reviewRecords.forEach((review) => {
      const belongsToDirection = direction === 'receivable'
        ? normalizePhone(review.lenderPhone) === userPhone
        : normalizePhone(review.borrowerPhone) === userPhone
      if (!belongsToDirection) return
      const requestType = review.kind === 'paid' ? 'repayment_submitted' : 'mistake_reported'
      if (!explicitKeys.has(`${requestType}:${review.id}`)) items.push({
        id: `review-request-${review.id}`,
        timestamp: timestampMillis(review.createdAt),
        kind: 'review-request',
        review,
      })
      if (review.status !== 'pending') {
        const resolutionType = review.kind === 'paid'
          ? review.status === 'approved' ? 'repayment_accepted' : 'repayment_rejected'
          : review.status === 'approved' ? 'correction_accepted' : 'correction_rejected'
        if (!explicitKeys.has(`${resolutionType}:${review.id}`)) items.push({
          id: `review-resolution-${review.id}`,
          timestamp: timestampMillis(review.resolvedAt ?? review.updatedAt),
          kind: 'review-resolution',
          review,
        })
      }
    })

    repaymentRequests.forEach((repayment) => {
      const belongsToDirection = direction === 'receivable'
        ? normalizePhone(repayment.lenderPhone) === userPhone
        : normalizePhone(repayment.borrowerPhone) === userPhone
      if (!belongsToDirection) return
      if (repayment.recordedBy !== 'lender' && !explicitKeys.has(`repayment_submitted:${repayment.id}`)) items.push({
        id: `repayment-request-${repayment.id}`,
        timestamp: timestampMillis(repayment.createdAt),
        kind: 'repayment-request',
        repayment,
      })
      const resolutionType = repayment.recordedBy === 'lender' && repayment.status === 'accepted'
        ? 'payment_recorded'
        : `repayment_${repayment.status}`
      if (repayment.status !== 'pending' && !explicitKeys.has(`${resolutionType}:${repayment.id}`)) {
        items.push({
          id: `repayment-resolution-${repayment.id}`,
          timestamp: timestampMillis(repayment.reviewedAt),
          kind: 'repayment-resolution',
          repayment,
        })
      }
    })

    return items.sort((a, b) => b.timestamp - a.timestamp)
  }, [activities, direction, relevantEntries, repaymentRequests, reviewRecords, userPhone])

  function loginToFirebase(uid: string, person: Person) {
    const firebaseUser = auth?.currentUser
    if (!firebaseUser || firebaseUser.uid !== uid) return
    const firebasePhone = firebaseUser.phoneNumber
    if (firebasePhone && toE164(firebasePhone) !== toE164(person.phone)) return
    setCurrentUser({ ...person, phone: firebasePhone || person.phone })
  }

  async function logout() {
    if (auth) await signOutOfFirebase(auth)
    setCurrentUser(null)
    setEntries([])
    setContacts([])
    setReviewRecords([])
    setRepaymentRequests([])
    setActivities([])
    setProfileOpen(false)
  }

  async function saveEntry(entry: LedgerEntry) {
    try {
      if (auth?.currentUser) {
        const creatorUid = auth.currentUser.uid
        await createFirebaseEntry(entry, creatorUid)
        setEntries((currentEntries) => [
          {
            ...entry,
            originalAmount: entry.amount,
            paidAmount: 0,
            remainingAmount: entry.amount,
            status: 'open',
            historyStarted: false,
            createdBy: creatorUid,
          },
          ...currentEntries.filter((currentEntry) => currentEntry.id !== entry.id),
        ])
      } else {
        throw new Error('Sign in required')
      }
      setDirection('receivable')
      setView('ledger')
      setAddDuePerson(null)
      setToast('Entry saved. Both sides now share the same record.')
    } catch (error) {
      const details = firebaseErrorDetails(error)
      console.error('[TallyBack] Ledger write failed', {
        code: details.code,
        message: details.message,
        entryId: entry.id,
        uid: auth?.currentUser?.uid ?? '',
      })
      setToast('Could not save this entry. Please try again.')
      throw error
    }
  }

  async function updateEntry(entry: LedgerEntry) {
    try {
      if (!auth?.currentUser) throw new Error('Sign in required')
      if (!currentUser) throw new Error('Profile unavailable')
      await updateFirebaseEntry(entry, auth.currentUser.uid, currentUser)
      const paidAmount = entryPaidAmount(entry)
      const remainingAmount = Math.max(0, entry.amount - paidAmount)
      const status = remainingAmount === 0 ? 'paid' : paidAmount > 0 ? 'partially_paid' : 'open'
      setEntries((currentEntries) => currentEntries.map((currentEntry) => (
        currentEntry.id === entry.id
          ? { ...currentEntry, ...entry, originalAmount: entry.amount, paidAmount, remainingAmount, status }
          : currentEntry
      )))
      setEditEntryTarget(null)
      setToast('Due updated in both ledgers.')
    } catch (error) {
      setToast('Could not update this due. Please try again.')
      throw error
    }
  }

  async function deleteDue(entry: LedgerEntry) {
    if (getSplitLedgerReference(entry.id)) throw new Error('Manage split dues from Splits.')
    if (
      entry.historyStarted
      || entry.review
      || (repaymentsByDue.get(entry.id)?.length ?? 0) > 0
      || (reviewRecordsByDue.get(entry.id)?.length ?? 0) > 0
    ) {
      throw new Error('Dues with payment or review history cannot be deleted.')
    }
    await deleteFirebaseEntry(entry.id)

    if (entry.screenshots?.length) {
      try {
        await deletePaymentScreenshots(entry.screenshots)
      } catch (error) {
        console.warn('[ledger/delete/screenshots]', error)
      }
    }

    setEntries((current) => current.filter((item) => item.id !== entry.id))
    setDeleteEntryTarget(null)
    if (reviewIntent?.id === entry.id) setReviewIntent(null)
    setToast('Due deleted from both ledgers.')
  }

  async function deleteContact(person: Person) {
    const firebaseUser = auth?.currentUser
    if (!firebaseUser) throw new Error('Sign in required.')
    const phone = normalizePhone(person.phone)
    const hasOpenDue = entries.some((entry) => (
      !isPaidEntry(entry)
      && normalizePhone(entry.lender.phone) === userPhone
      && normalizePhone(entry.borrower.phone) === phone
    ))
    if (hasOpenDue) throw new Error('Settle or delete every open due before deleting this contact.')

    await deleteFirebaseContact(firebaseUser.uid, phone)
    setContacts((current) => current.filter((contact) => normalizePhone(contact.phone) !== phone))
    setSelectedPhone(null)
    setDeleteContactTarget(null)
    setToast(`${person.name} deleted. Paid history remains in Activity.`)
  }

  async function sendReviewRequest(entry: LedgerEntry, submission: ReviewSubmissionDraft) {
    const firebaseUser = auth?.currentUser
    if (!firebaseUser) throw new Error('Sign in required')
    const { proofFiles, ...draft } = submission
    let proofScreenshots: PaymentScreenshot[] = []
    try {
      if (proofFiles.length) {
        proofScreenshots = await uploadPaymentScreenshots(entry.id, firebaseUser.uid, proofFiles)
      }
      await createReviewRequest(entry, firebaseUser.uid, { ...draft, proofScreenshots })
      setToast(draft.kind === 'paid' ? 'Payer screenshot sent for confirmation.' : 'Correction sent for review.')
    } catch (error) {
      if (proofScreenshots.length) {
        try {
          await deletePaymentScreenshots(proofScreenshots)
        } catch (cleanupError) {
          console.warn('[review/proof/cleanup]', cleanupError)
        }
      }
      throw error
    }
  }

  async function sendRepayment(entry: LedgerEntry, submission: RepaymentSubmissionDraft) {
    const firebaseUser = auth?.currentUser
    if (!firebaseUser || !currentUser) throw new Error('Sign in again before recording payment.')
    const { proofFiles, ...draft } = submission
    let proofScreenshots: PaymentScreenshot[] = []
    try {
      const authenticatedPhone = await getAuthenticatedPhone(firebaseUser, true)
      if (authenticatedPhone !== toE164(entry.borrower.phone)) {
        throw new Error('Signed-in number does not match borrower on this due.')
      }
      proofScreenshots = await uploadPaymentScreenshots(entry.id, firebaseUser.uid, proofFiles)
      await createRepaymentRequest(entry, firebaseUser.uid, currentUser, { ...draft, proofScreenshots })
      setToast('Payment sent to lender for approval.')
    } catch (error) {
      if (proofScreenshots.length) {
        try {
          await deletePaymentScreenshots(proofScreenshots)
        } catch (cleanupError) {
          console.warn('[repayment/proof/cleanup]', cleanupError)
        }
      }
      throw error
    }
  }

  async function saveLenderPayment(entry: LedgerEntry, submission: RepaymentSubmissionDraft) {
    const firebaseUser = auth?.currentUser
    if (!firebaseUser || !currentUser) throw new Error('Sign in again before recording payment.')
    const { proofFiles, ...draft } = submission
    let proofScreenshots: PaymentScreenshot[] = []
    try {
      const authenticatedPhone = await getAuthenticatedPhone(firebaseUser, true)
      if (authenticatedPhone !== toE164(entry.lender.phone) || entry.createdBy !== firebaseUser.uid) {
        throw new Error('Only lender who created this due can record payment.')
      }
      if (proofFiles.length) {
        proofScreenshots = await uploadPaymentScreenshots(entry.id, firebaseUser.uid, proofFiles)
      }
      await recordLenderPayment(entry, firebaseUser.uid, currentUser, { ...draft, proofScreenshots })
      setToast(draft.amount === entryRemainingAmount(entry)
        ? 'Payment recorded. Due marked paid.'
        : 'Partial payment recorded. Balance updated.')
    } catch (error) {
      if (proofScreenshots.length) {
        try {
          await deletePaymentScreenshots(proofScreenshots)
        } catch (cleanupError) {
          console.warn('[lender-payment/proof/cleanup]', cleanupError)
        }
      }
      throw error
    }
  }

  async function resolveRepayment(request: RepaymentRequest, decision: 'accepted' | 'rejected') {
    try {
      const firebaseUser = auth?.currentUser
      if (!firebaseUser || !currentUser) throw new Error('Sign in required')
      setResolvingRepaymentId(request.id)
      await resolveRepaymentRequest(request, decision, firebaseUser.uid, currentUser)
      setToast(decision === 'accepted'
        ? 'Payment accepted. Remaining balance updated.'
        : 'Payment rejected. Due balance unchanged.')
    } catch (error) {
      setToast(actionableFirebaseError(error, 'Could not review payment. Refresh and retry.'))
    } finally {
      setResolvingRepaymentId(null)
    }
  }

  async function resolveReview(
    review: LedgerReview,
    entry: LedgerEntry,
    decision: 'approved' | 'rejected',
  ) {
    try {
      setResolvingReviewId(entry.id)
      if (!auth?.currentUser) throw new Error('Sign in required')
      await resolveReviewRequest(review, entry, decision, auth.currentUser.uid)
      setToast(decision === 'approved'
        ? review.kind === 'paid' ? 'Payment confirmed and marked as paid.' : 'Correction approved and ledger updated.'
        : review.kind === 'paid' ? 'Payment claim rejected.' : 'Correction rejected without changing the due.')
    } catch {
      setToast('Could not resolve this review request. Please try again.')
    } finally {
      setResolvingReviewId(null)
    }
  }

  function openFirstIncomingReview() {
    const entry = incomingReviewEntries[0]
      ?? entries.find((candidate) => candidate.id === incomingRepayments[0]?.dueId)
    if (!entry) return
    setView('ledger')
    setDirection('receivable')
    setSelectedPhone(normalizePhone(entry.borrower.phone))
  }

  async function addManualContact(person: Person) {
    const firebaseUser = auth?.currentUser
    if (!firebaseUser) throw new Error('Sign in required')
    const phone = normalizePhone(person.phone)
    if (phone === userPhone) throw new Error('You cannot add your own number.')

    const savedContact: SavedContact = { ...person, phone: toE164(phone), source: 'manual' }
    await saveContact(firebaseUser.uid, savedContact, 'manual')
    setContacts((current) => [savedContact, ...current.filter((item) => normalizePhone(item.phone) !== phone)])
    setDirection('receivable')
    setToast(`${savedContact.name} added. Add first due inside their ledger.`)
    window.setTimeout(() => setSelectedPhone(phone), 260)
  }

  async function importDeviceContacts() {
    const firebaseUser = auth?.currentUser
    if (!firebaseUser) throw new Error('Sign in required')

    setImportingContacts(true)
    try {
      const picked = (await pickDeviceContacts()).filter((person) => normalizePhone(person.phone) !== userPhone)
      if (!picked.length) throw new Error('No valid 10-digit mobile numbers selected.')
      await saveContacts(firebaseUser.uid, picked, 'device')
      const imported = picked.map((person) => ({ ...person, source: 'device' as const }))
      setContacts((current) => {
        const merged = new Map(current.map((contact) => [normalizePhone(contact.phone), contact]))
        imported.forEach((contact) => merged.set(normalizePhone(contact.phone), contact))
        return [...merged.values()]
      })
      setShowAddPerson(false)
      if (imported.length === 1) setSelectedPhone(normalizePhone(imported[0].phone))
      setDirection('receivable')
      setToast(`${imported.length} ${imported.length === 1 ? 'contact' : 'contacts'} added.`)
    } finally {
      setImportingContacts(false)
    }
  }

  async function chooseContacts() {
    if (!canPickDeviceContacts()) {
      setShowAddPerson(true)
      return
    }
    try {
      await importDeviceContacts()
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        setToast((error as Error).message || 'Could not open device contacts.')
      }
    }
  }

  function startAddDue(person: Person) {
    setSelectedPhone(normalizePhone(person.phone))
    setAddDuePerson(person)
  }

  async function saveRequiredProfileName(name: string) {
    const firebaseUser = auth?.currentUser
    if (!firebaseUser || !currentUser) {
      throw new Error('Your session expired. Sign in again.')
    }

    const cleanName = name.trim()
    if (!hasProfileName(cleanName)) throw new Error('Enter your name to continue.')

    const nextUser = { ...currentUser, name: cleanName }
    await saveUserProfile(firebaseUser.uid, nextUser)
    await syncParticipantName(entries, firebaseUser.uid, nextUser.phone, cleanName)
    setEntries((current) => current.map((entry) => ({
      ...entry,
      lender: normalizePhone(entry.lender.phone) === normalizePhone(nextUser.phone)
        ? { ...entry.lender, name: cleanName }
        : entry.lender,
      borrower: normalizePhone(entry.borrower.phone) === normalizePhone(nextUser.phone)
        ? { ...entry.borrower, name: cleanName }
        : entry.borrower,
    })))
    setCurrentUser(nextUser)
  }

  const requiresProfileName = Boolean(currentUser && !hasProfileName(currentUser.name))

  if (authLoading) return null

  if (!currentUser) {
    return <LoginScreen onAuthenticated={loginToFirebase} />
  }

  return (
    <div className={`app-shell ${view === 'ledger' ? 'ledger-view-shell' : ''}`}>
      {requiresProfileName
        ? createPortal(<RequiredNameModal onSave={saveRequiredProfileName} />, document.body)
        : null}
      <aside className="sidebar">
        <a className="brand" href="#" aria-label="TallyBack home">
          <BrandMark />
          <span>TallyBack</span>
        </a>
        <nav className="side-nav" aria-label="Primary navigation">
          <button className={view === 'ledger' ? 'active' : ''} onClick={() => setView('ledger')}>
            <ReceiptText size={19} /> Dues
          </button>
          {SPLITS_ENABLED ? (
            <button className={view === 'splits' ? 'active' : ''} onClick={() => setView('splits')}>
              <Split size={19} /> Splits
            </button>
          ) : null}
          <button className={view === 'activity' ? 'active' : ''} onClick={() => setView('activity')}>
            <History size={19} /> Activity
          </button>
        </nav>
        <div className="sidebar-card">
          <Contact size={18} />
          <p><strong>One person, one ledger</strong>Keep every due and payment proof together.</p>
        </div>
        <p className="sidebar-foot">Synced securely with Firebase</p>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="mobile-logo"><BrandMark /><span>TallyBack</span></div>
          <div className="topbar-actions">
            <button
              className={`icon-button notification-button ${incomingReviewEntries.length + incomingRepayments.length ? 'has-notifications' : ''}`}
              aria-label={incomingReviewEntries.length + incomingRepayments.length ? `Open ${incomingReviewEntries.length + incomingRepayments.length} pending ${incomingReviewEntries.length + incomingRepayments.length === 1 ? 'request' : 'requests'}` : 'No pending requests'}
              onClick={openFirstIncomingReview}
              disabled={!incomingReviewEntries.length && !incomingRepayments.length}
            >
              <Bell size={19} />
              {incomingReviewEntries.length + incomingRepayments.length ? (
                <span aria-hidden="true">{incomingReviewEntries.length + incomingRepayments.length > 9 ? '9+' : incomingReviewEntries.length + incomingRepayments.length}</span>
              ) : null}
            </button>
            <div className="profile-wrap" ref={profileMenuRef}>
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
              <section className="people-workspace">
                <div className="balance-switch people-balance-switch" role="tablist" aria-label="Choose ledger side">
                  <button role="tab" aria-selected={direction === 'receivable'} className={`receive ${direction === 'receivable' ? 'active' : ''}`} onClick={() => setDirection('receivable')}>
                    <span className="switch-icon"><ArrowDownLeft size={19} /></span>
                    <span><small>To receive</small><strong>{money.format(ledgerTotals.receivable)}</strong></span>
                  </button>
                  <button role="tab" aria-selected={direction === 'payable'} className={`pay ${direction === 'payable' ? 'active' : ''}`} onClick={() => setDirection('payable')}>
                    <span className="switch-icon"><ArrowUpRight size={19} /></span>
                    <span><small>To pay</small><strong>{money.format(ledgerTotals.payable)}</strong></span>
                  </button>
                </div>

                <div className="people-toolbar">
                  <div className="people-toolbar-summary">
                    <div>
                      <h2>{direction === 'receivable' ? 'People who owe you' : 'People you owe'}</h2>
                      <p>{allSummaries.length} {allSummaries.length <= 1 ? 'person' : 'people'}</p>
                    </div>
                    <div className={`people-toolbar-total ${direction}`}>
                      <span>{direction === 'receivable' ? 'Total to receive' : 'Total to pay'}</span>
                      <strong>{money.format(direction === 'receivable' ? ledgerTotals.receivable : ledgerTotals.payable)}</strong>
                    </div>
                  </div>
                  <div className="people-toolbar-actions">
                    <label className="people-search">
                      <Search size={17} />
                      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or number" />
                    </label>
                    {direction === 'receivable' && !dataLoading && !contactsLoading && allSummaries.length > 0 ? (
                      <button className="add-person-inline" type="button" onClick={chooseContacts} disabled={importingContacts}>
                        <Contact size={17} />
                        <span>{importingContacts ? 'Opening…' : 'Add person'}</span>
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="contact-ledger-grid" ref={ledgerGridRef}>
                  {pullDistance > 0 || pullRefreshing ? (
                    <div
                      className={`pull-refresh-indicator${pullRefreshing ? ' refreshing' : ''}`}
                      style={{
                        '--pull-distance': `${pullDistance}px`,
                        opacity: Math.min(pullDistance / 22, 1),
                      } as CSSProperties}
                      aria-live={pullRefreshing ? 'polite' : 'off'}
                    >
                      <span>
                        <LoaderCircle size={16} />
                        {pullRefreshing ? 'Refreshing…' : pullDistance >= 52 ? 'Release to refresh' : 'Pull to refresh'}
                      </span>
                    </div>
                  ) : null}
                  {(dataLoading || contactsLoading) ? <div className="ledger-loading">Syncing people and dues…</div> : null}
                  {!dataLoading && !contactsLoading && summaries.map((summary) => {
                    return (
                      <article className="contact-ledger-card" key={summary.person.phone}>
                        <button className="contact-ledger-main" type="button" onClick={() => setSelectedPhone(normalizePhone(summary.person.phone))}>
                          <Avatar person={summary.person} />
                          <span className="contact-ledger-copy">
                            <strong>{summary.person.name}</strong>
                            <small>{formatPhone(summary.person.phone)}</small>
                          </span>
                          <span className="contact-ledger-amount">
                            <strong className={direction === 'payable' ? 'amount-negative' : ''}>{summary.openCount ? money.format(summary.total) : 'No dues'}</strong>
                            <small className={summary.pendingCount ? 'has-pending' : ''}>
                              {summary.openCount ? `${summary.openCount} open` : 'Ready when needed'}
                              {summary.pendingCount
                                ? ` · ${summary.pendingCount} ${direction === 'receivable' ? 'to review' : 'awaiting approval'}`
                                : ''}
                            </small>
                          </span>
                        </button>
                      </article>
                    )
                  })}
                  {!dataLoading && !contactsLoading && summaries.length === 0 ? (
                    <div className={`people-empty-state ${!search && direction === 'receivable' ? 'compact' : ''}`}>
                      {search || direction === 'payable' ? <span><Contact size={25} /></span> : null}
                      {search ? (
                        <>
                          <h3>No matching person</h3>
                          <p>Search another name or mobile number.</p>
                        </>
                      ) : direction === 'payable' ? (
                        <>
                          <h3>Nothing to pay back</h3>
                          <p>If you owe anyone, it will appear here.</p>
                        </>
                      ) : null}
                      {!search && direction === 'receivable' ? (
                        <button className="primary-button" type="button" onClick={chooseContacts}><Contact size={17} /> {contactPickerAvailable ? 'Choose contacts' : 'Add person'}</button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </section>
            ) : view === 'activity' ? (
              <section className="activity-view">
                <div className="activity-tabs">
                  <button className={direction === 'receivable' ? 'active' : ''} onClick={() => setDirection('receivable')}>To receive</button>
                  <button className={direction === 'payable' ? 'active' : ''} onClick={() => setDirection('payable')}>To pay</button>
                </div>
                <div className="activity-list">
                  {!activityItems.length ? (
                    <div className="activity-empty-state">
                      <History size={22} />
                      <strong>No activity yet</strong>
                      <span>{direction === 'receivable' ? 'New dues and incoming payments appear here.' : 'Payments and review updates appear here.'}</span>
                    </div>
                  ) : null}
                  {activityItems.map((item) => {
                    if (item.kind === 'activity') {
                      const { activity } = item
                      const entry = entries.find((candidate) => candidate.id === activity.dueId)
                      const person = direction === 'receivable' ? activity.borrower : activity.lender
                      const titles: Record<LedgerActivity['type'], string> = {
                        due_created: 'Due created',
                        due_edited: 'Due edited',
                        repayment_submitted: 'Repayment submitted',
                        repayment_accepted: 'Repayment accepted',
                        repayment_rejected: 'Repayment rejected',
                        payment_recorded: 'Payment recorded',
                        mistake_reported: 'Mistake reported',
                        correction_accepted: 'Correction accepted',
                        correction_rejected: 'Correction rejected',
                        due_marked_paid: 'Due marked paid',
                      }
                      const rejected = activity.type === 'repayment_rejected' || activity.type === 'correction_rejected'
                      const pending = activity.type === 'repayment_submitted' || activity.type === 'mistake_reported'
                      const completed = activity.type === 'repayment_accepted' || activity.type === 'payment_recorded' || activity.type === 'correction_accepted' || activity.type === 'due_marked_paid'
                      const StateIcon = rejected ? X : pending ? Flag : completed ? Check : activity.type === 'due_edited' ? Pencil : ReceiptText
                      const eventTime = timestampMillis(activity.occurredAt)
                      return (
                        <article className="activity-row" key={item.id}>
                          <span className={`activity-state activity-event ${activity.status}`}><StateIcon size={17} /></span>
                          <div>
                            <h3>{titles[activity.type]}</h3>
                            <p>
                              {activity.actorName} · {person.name} · {entry?.occasion ?? 'Due'} · {eventTime ? dateTime.format(new Date(eventTime)) : shortDate.format(new Date(`${activity.eventDate}T00:00:00`))}
                            </p>
                          </div>
                          <div className="activity-amount">
                            <strong>{money.format(activity.amount)}</strong>
                            <span className={activity.status}>{activity.status.replace('_', ' ')}</span>
                          </div>
                        </article>
                      )
                    }

                    if (item.kind === 'entry') {
                      const { entry } = item
                      const entryPerson = direction === 'receivable' ? entry.borrower : entry.lender
                      const person = contactsByPhone.get(normalizePhone(entryPerson.phone)) ?? entryPerson
                      const Icon = methodIcons[entry.method]
                      const status = canonicalEntryStatus(entry)
                      return (
                        <article className="activity-row" key={item.id}>
                          <span className={`activity-state ${status}`}>
                            {status === 'paid' ? <Check size={17} /> : <Icon size={17} />}
                          </span>
                          <div>
                            <h3>Due created</h3>
                            <p>{entry.lender.name} · {person.name} · {entry.occasion} · {shortDate.format(new Date(`${entry.date}T00:00:00`))}</p>
                          </div>
                          <div className="activity-amount">
                            <strong>{money.format(entryOriginalAmount(entry))}</strong>
                            <span className={pendingReviews.has(entry.id) ? 'review' : status}>
                              {pendingReviews.has(entry.id) ? 'Review pending' : status.replace('_', ' ')}
                            </span>
                          </div>
                        </article>
                      )
                    }

                    if ('repayment' in item) {
                      const { repayment } = item
                      const isResolution = item.kind === 'repayment-resolution'
                      const accepted = repayment.status === 'accepted'
                      const lenderRecorded = repayment.recordedBy === 'lender'
                      const entry = entries.find((candidate) => candidate.id === repayment.dueId)
                      const person = direction === 'receivable' ? entry?.borrower : entry?.lender
                      return (
                        <article className="activity-row review-activity-row" key={item.id}>
                          <span className={`activity-state review-event ${isResolution ? repayment.status : 'review'}`}>
                            {isResolution ? accepted ? <Check size={17} /> : <X size={17} /> : <ArrowUpRight size={17} />}
                          </span>
                          <div>
                            <h3>{isResolution ? accepted ? lenderRecorded ? 'Payment recorded' : 'Repayment accepted' : 'Repayment rejected' : 'Repayment submitted'}</h3>
                            <p>{isResolution ? entry?.lender.name ?? 'Lender' : repayment.payerName} · {person?.name ?? 'Participant'} · {entry?.occasion ?? 'Due'} · {shortDate.format(new Date(`${repayment.paidAt}T00:00:00`))}</p>
                          </div>
                          <div className="activity-amount">
                            <strong>{money.format(repayment.amount)}</strong>
                            <span className={isResolution ? repayment.status : 'review'}>{isResolution ? accepted ? lenderRecorded ? 'Recorded' : 'Accepted' : 'Rejected' : 'Pending'}</span>
                          </div>
                        </article>
                      )
                    }

                    const { review } = item
                    const isResolution = item.kind === 'review-resolution'
                    const approved = review.status === 'approved'
                    const eventTitle = isResolution
                      ? review.kind === 'paid'
                        ? approved ? 'Payment marked as paid' : 'Payment claim rejected'
                        : approved ? 'Correction accepted' : 'Correction rejected'
                      : review.kind === 'paid' ? 'Payer screenshot submitted' : 'Mistake reported'
                    const eventState = isResolution ? review.status : 'review'
                    return (
                      <article className="activity-row review-activity-row" key={item.id}>
                        <span className={`activity-state review-event ${eventState}`}>
                          {isResolution ? approved ? <Check size={17} /> : <X size={17} /> : <Flag size={17} />}
                        </span>
                        <div>
                          <h3>{eventTitle}</h3>
                          <p>{review.borrower.name} · {review.originalOccasion} · {shortDate.format(new Date(`${review.originalDate}T00:00:00`))}</p>
                        </div>
                        <div className="activity-amount">
                          <strong>{money.format(review.kind === 'amount' ? review.proposedAmount : review.originalAmount)}</strong>
                          <span className={eventState}>{isResolution ? approved ? 'Accepted' : 'Rejected' : 'Requested'}</span>
                        </div>
                      </article>
                    )
                  })}
                </div>
              </section>
            ) : (
              <Suspense fallback={<div className="ledger-loading">Opening splits…</div>}>
                <SplitWorkspace currentUser={currentUser} onNotice={setToast} />
              </Suspense>
            )}
          </section>

        </div>
      </main>

      <nav className={`mobile-nav ${SPLITS_ENABLED ? '' : 'splits-disabled'}`} aria-label="Mobile navigation">
        <button className={view === 'ledger' ? 'active' : ''} onClick={() => setView('ledger')}><ReceiptText size={20} /><span>Dues</span></button>
        {SPLITS_ENABLED ? <button className={view === 'splits' ? 'active' : ''} onClick={() => setView('splits')}><Split size={20} /><span>Splits</span></button> : null}
        <button className={view === 'activity' ? 'active' : ''} onClick={() => setView('activity')}><History size={20} /><span>Activity</span></button>
      </nav>

      {showAddPerson ? <AddPersonModal onClose={() => setShowAddPerson(false)} onSave={addManualContact} onImport={importDeviceContacts} contactPickerAvailable={contactPickerAvailable} /> : null}
      {selectedSummary && <PersonDrawer
        summary={selectedSummary}
        direction={direction}
        pendingReviews={pendingReviews}
        repaymentRequests={repaymentsByDue}
        reviewHistory={reviewRecordsByDue}
        resolvingReviewId={resolvingReviewId}
        resolvingRepaymentId={resolvingRepaymentId}
        onClose={() => setSelectedPhone(null)}
        onAddDue={startAddDue}
        onEditDue={setEditEntryTarget}
        onDeleteContact={setDeleteContactTarget}
        onDeleteDue={setDeleteEntryTarget}
        onOpenSplit={() => {
          if (!SPLITS_ENABLED) return
          setSelectedPhone(null)
          setView('splits')
        }}
        onRequestReview={setReviewIntent}
        onResolveReview={resolveReview}
        onRecordPayment={(entry) => setRepaymentIntent({
          entry,
          mode: direction === 'receivable' ? 'record' : 'request',
        })}
        onResolveRepayment={resolveRepayment}
      />}
      {addDuePerson ? <AddEntryModal currentUser={currentUser} contact={addDuePerson} onClose={() => setAddDuePerson(null)} onSave={saveEntry} /> : null}
      {editEntryTarget ? <AddEntryModal currentUser={currentUser} contact={editEntryTarget.borrower} entry={editEntryTarget} onClose={() => setEditEntryTarget(null)} onSave={updateEntry} /> : null}
      {reviewIntent ? <ReviewRequestModal
        entry={reviewIntent}
        onClose={() => setReviewIntent(null)}
        onSend={(draft) => sendReviewRequest(reviewIntent, draft)}
      /> : null}
      {repaymentIntent ? <RepaymentModal
        entry={repaymentIntent.entry}
        mode={repaymentIntent.mode}
        onClose={() => setRepaymentIntent(null)}
        onSend={(draft) => repaymentIntent.mode === 'record'
          ? saveLenderPayment(repaymentIntent.entry, draft)
          : sendRepayment(repaymentIntent.entry, draft)}
      /> : null}
      {deleteEntryTarget ? <DeleteDueModal entry={deleteEntryTarget} onClose={() => setDeleteEntryTarget(null)} onDelete={deleteDue} /> : null}
      {deleteContactTarget ? <DeleteContactModal person={deleteContactTarget} onClose={() => setDeleteContactTarget(null)} onDelete={deleteContact} /> : null}
      {toast && <div className="toast" role="status"><CheckCircle2 size={18} /> {toast}</div>}
    </div>
  )
}

function App() {
  const match = window.location.pathname.match(/^\/split\/([a-z0-9-]+)\/?$/i)
  if (match) return (
    <Suspense fallback={<main className="split-public-state"><LoaderCircle className="spin" size={25} /><strong>Opening shared expense…</strong></main>}>
      <SplitPublicPage splitId={match[1]} />
    </Suspense>
  )
  return <TallyBackApp />
}

export default App
