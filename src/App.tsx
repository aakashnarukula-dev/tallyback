import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  ConfirmationResult,
  onAuthStateChanged,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  signOut as signOutOfFirebase,
} from 'firebase/auth'
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  Bell,
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
  Plus,
  ReceiptText,
  Search,
  ShieldCheck,
  Split,
  Smartphone,
  Trash2,
  UsersRound,
  WalletCards,
  X,
} from 'lucide-react'
import {
  avatarColor,
  initials,
  LedgerEntry,
  LedgerReview,
  normalizePhone,
  PaymentScreenshot,
  PaymentMethod,
  Person,
  SavedContact,
} from './data'
import { auth, isFirebaseConfigured } from './firebase'
import {
  createEntry as createFirebaseEntry,
  deleteEntry as deleteFirebaseEntry,
  getUserProfile,
  saveUserProfile,
  settleEntry as settleFirebaseEntry,
  subscribeToEntries,
  toE164,
} from './firebase-ledger'
import {
  canPickDeviceContacts,
  pickDeviceContacts,
  saveContact,
  saveContacts,
  subscribeToContacts,
} from './firebase-contacts'
import {
  createReviewRequest,
  resolveReviewRequest,
  ReviewDraft,
} from './firebase-reviews'
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
import SplitPublicPage from './SplitPublicPage'
import SplitWorkspace from './SplitWorkspace'

type Direction = 'receivable' | 'payable'
type View = 'ledger' | 'activity' | 'splits'

type ContactSummary = {
  person: Person
  total: number
  openCount: number
  latestDate?: string
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
  const [truecallerArmed, setTruecallerArmed] = useState(false)
  const truecallerController = useRef<AbortController | null>(null)
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
      onAuthenticated(person)
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
      onAuthenticated(person)
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

  function changePhone(nextPhone: string) {
    const normalizedPhone = nextPhone.replace(/[^0-9]/g, '').slice(0, 10)

    if (confirmation && normalizedPhone !== phone) {
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
    verificationAttempt.current = ''
    setError('')
    setCode(nextCode.replace(/[^0-9]/g, '').slice(0, 6))
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
          <p className="login-step">{confirmation ? 'Check your messages' : 'Welcome'}</p>
          <h2>{confirmation ? 'Enter your code.' : 'Your money, remembered.'}</h2>
          <p className="login-subtitle">
            {confirmation
              ? `We sent a 6-digit verification code to +91 ${phone.slice(0, 5)} ${phone.slice(5)}.`
              : 'Use the mobile number your friends know. Your shared entries will be waiting for you.'}
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
          <p className="login-fine-print">
            Truecaller verifies your number without an OTP on supported Android devices. SMS is available as a secure fallback.
          </p>
          <div id="recaptcha-container" />
        </form>
      </section>
    </main>
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
    <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!working) onClose() }}>
      <section className="modal-card add-person-modal" role="dialog" aria-modal="true" aria-labelledby="add-person-title" onMouseDown={(event) => event.stopPropagation()}>
        <span className="sheet-grabber" aria-hidden="true" />
        <div className="modal-header">
          <div>
            <p className="modal-kicker">New person</p>
            <h2 id="add-person-title">Who do you lend to?</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog" disabled={working}><X size={20} /></button>
        </div>

        {contactPickerAvailable ? (
          <button className="contact-import-card" type="button" onClick={importContacts} disabled={working}>
            <span><Contact size={20} /></span>
            <span><strong>Choose from contacts</strong><small>Select one or more people from your phone</small></span>
            <ChevronRight size={18} />
          </button>
        ) : null}

        <div className="modal-separator"><span>{contactPickerAvailable ? 'or enter manually' : 'Enter contact details'}</span></div>

        <form onSubmit={submit}>
          <div className="person-form-grid">
            <label>
              Contact name
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Surya" autoComplete="name" maxLength={120} autoFocus={!contactPickerAvailable} />
            </label>
            <label>
              Mobile number
              <div className="phone-input compact">
                <span>+91</span>
                <input value={phone} onChange={(event) => setPhone(event.target.value.replace(/[^0-9]/g, '').slice(0, 10))} placeholder="98765 43210" inputMode="numeric" autoComplete="tel" />
              </div>
            </label>
          </div>
          {error ? <p className="form-error">{error}</p> : null}
          <div className="modal-actions">
            <button className="secondary-button" type="button" onClick={onClose} disabled={working}>Cancel</button>
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
  onClose,
  onSave,
}: {
  currentUser: Person
  contact: Person
  onClose: () => void
  onSave: (entry: LedgerEntry) => Promise<void>
}) {
  const [amount, setAmount] = useState('')
  const [occasion, setOccasion] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('UPI')
  const [date, setDate] = useState(today())
  const [error, setError] = useState('')
  const [screenshots, setScreenshots] = useState<Array<{
    id: string
    file: File
    previewUrl: string
  }>>([])
  const [saving, setSaving] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{ completed: number; total: number } | null>(null)
  const screenshotInput = useRef<HTMLInputElement | null>(null)
  const previewUrls = useRef(new Set<string>())

  useEffect(() => () => {
    previewUrls.current.forEach((url) => URL.revokeObjectURL(url))
    previewUrls.current.clear()
  }, [])

  function addScreenshots(event: ChangeEvent<HTMLInputElement>) {
    const incoming = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    if (!incoming.length) return

    const remainingSlots = MAX_PAYMENT_SCREENSHOTS - screenshots.length
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
      validationError = `You can attach up to ${MAX_PAYMENT_SCREENSHOTS} screenshots.`
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

  async function submit(event: FormEvent) {
    event.preventDefault()
    const numericAmount = Number(amount)
    if (!numericAmount || numericAmount <= 0 || !occasion.trim()) {
      setError('Add the amount and what it was for.')
      return
    }

    if (!auth?.currentUser) {
      setError('Sign in again before saving this entry.')
      return
    }

    const entryId = `loan-${Date.now()}`
    let uploadedScreenshots: PaymentScreenshot[] = []

    try {
      setSaving(true)
      setError('')
      if (screenshots.length) {
        setUploadProgress({ completed: 0, total: screenshots.length })
        uploadedScreenshots = await uploadPaymentScreenshots(
          entryId,
          auth.currentUser.uid,
          screenshots.map(({ file }) => file),
          (completed, total) => setUploadProgress({ completed, total }),
        )
      }

      await onSave({
        id: entryId,
        lender: currentUser,
        borrower: contact,
        amount: numericAmount,
        occasion: occasion.trim(),
        method,
        date,
        status: 'open',
        ...(uploadedScreenshots.length ? { screenshots: uploadedScreenshots } : {}),
      })
    } catch {
      if (uploadedScreenshots.length) await deletePaymentScreenshots(uploadedScreenshots)
      setError('Could not upload or save this entry. Check your connection and try again.')
    } finally {
      setSaving(false)
      setUploadProgress(null)
    }
  }

  const saveLabel = saving
    ? uploadProgress
      ? `Uploading ${uploadProgress.completed}/${uploadProgress.total}`
      : 'Saving…'
    : 'Save entry'

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!saving) onClose() }}>
      <section
        className="modal-card add-entry-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-entry-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="sheet-grabber" aria-hidden="true" />
        <div className="modal-header add-entry-header">
          <div>
            <p className="modal-kicker">{contact.name}</p>
            <h2 id="add-entry-title">Add due</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog" disabled={saving}>
            <X size={20} />
          </button>
        </div>

        <form className="add-entry-form" onSubmit={submit}>
          <div className="add-entry-body">
            <div className="entry-authorship-note">
              <ArrowDownLeft size={18} />
              <div><strong>You paid for {contact.name}</strong><span>This due appears in both ledgers.</span></div>
            </div>

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
              <label className="entry-date-field">
                Date
                <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
              </label>
            </div>

            <section className="payment-upload" aria-labelledby="payment-upload-title">
              <div className="payment-upload-heading">
                <div>
                  <strong id="payment-upload-title">Payment screenshots</strong>
                  <span>Optional · up to 5 images, 6 MB each</span>
                </div>
                <button
                  className="payment-upload-button"
                  type="button"
                  onClick={() => screenshotInput.current?.click()}
                  disabled={saving || screenshots.length >= MAX_PAYMENT_SCREENSHOTS}
                >
                  <ImagePlus size={16} /> Add images
                </button>
                <input
                  ref={screenshotInput}
                  className="visually-hidden"
                  type="file"
                  accept={acceptedScreenshotTypes.join(',')}
                  multiple
                  onChange={addScreenshots}
                  aria-label="Upload payment screenshots"
                />
              </div>

              {screenshots.length ? (
                <div className="payment-preview-rail" aria-label="Selected payment screenshots">
                  {screenshots.map((screenshot, index) => (
                    <figure className="payment-preview-card" key={screenshot.id}>
                      <img src={screenshot.previewUrl} alt={`Payment screenshot ${index + 1}`} />
                      <figcaption>{index + 1}</figcaption>
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
              ) : (
                <button
                  className="payment-upload-empty"
                  type="button"
                  onClick={() => screenshotInput.current?.click()}
                  disabled={saving}
                >
                  <ImageIcon size={18} />
                  <span>Add receipts or payment confirmations</span>
                </button>
              )}
            </section>

            {error && <p className="form-error">{error}</p>}
          </div>
          <div className="modal-actions add-entry-actions">
            <button className="secondary-button" type="button" onClick={onClose} disabled={saving}>Cancel</button>
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

function PaymentScreenshotGallery({ screenshots }: { screenshots: PaymentScreenshot[] }) {
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({})
  const [failedPaths, setFailedPaths] = useState<string[]>([])
  const [activeScreenshot, setActiveScreenshot] = useState<{ url: string; name: string } | null>(null)

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
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setActiveScreenshot(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [activeScreenshot])

  return (
    <div className="ledger-proof-block">
      <div className="ledger-proof-heading">
        <span><ImageIcon size={13} /> Payment proof</span>
        <small>{screenshots.length} {screenshots.length === 1 ? 'image' : 'images'}</small>
      </div>
      <div className="ledger-proof-rail">
        {screenshots.map((screenshot, index) => {
          const imageUrl = imageUrls[screenshot.path]
          const failed = failedPaths.includes(screenshot.path)
          return (
            <button
              type="button"
              className="ledger-proof-image"
              key={screenshot.path}
              onClick={() => imageUrl && setActiveScreenshot({ url: imageUrl, name: screenshot.name })}
              disabled={!imageUrl}
              aria-label={`View payment screenshot ${index + 1}`}
            >
              {imageUrl ? (
                <img src={imageUrl} alt="" />
              ) : failed ? (
                <span><ImageIcon size={18} /> Unavailable</span>
              ) : (
                <span><LoaderCircle className="spin" size={18} /> Loading</span>
              )}
              <b>{index + 1}</b>
            </button>
          )
        })}
      </div>

      {activeScreenshot ? (
        <div className="screenshot-lightbox" role="presentation" onMouseDown={() => setActiveScreenshot(null)}>
          <section role="dialog" aria-modal="true" aria-label="Payment screenshot" onMouseDown={(event) => event.stopPropagation()}>
            <button type="button" onClick={() => setActiveScreenshot(null)} aria-label="Close screenshot">
              <X size={20} />
            </button>
            <img src={activeScreenshot.url} alt={activeScreenshot.name} />
          </section>
        </div>
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
  onSend: (draft: ReviewDraft) => Promise<void>
}) {
  const [kind, setKind] = useState<ReviewDraft['kind']>('amount')
  const [amount, setAmount] = useState(String(entry.amount))
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const proposedAmount = kind === 'amount' ? Number(amount) : 0
    if (kind === 'amount' && (!Number.isFinite(proposedAmount) || proposedAmount <= 0)) {
      setError('Enter the amount you believe is correct.')
      return
    }
    if (kind === 'amount' && proposedAmount === entry.amount) {
      setError('Enter an amount different from the current record.')
      return
    }

    try {
      setWorking(true)
      setError('')
      await onSend({ kind, proposedAmount, note })
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

        <div className="review-entry-context">
          <span>{entry.occasion}</span>
          <strong>{money.format(entry.amount)}</strong>
          <small>Recorded by {entry.lender.name}</small>
        </div>

        <form onSubmit={submit}>
          <div className="review-reason-picker" aria-label="Choose what is incorrect">
            <button type="button" className={kind === 'amount' ? 'active' : ''} aria-pressed={kind === 'amount'} onClick={() => setKind('amount')}>
              <Banknote size={18} />
              <span><strong>Wrong amount</strong><small>Suggest the correct amount</small></span>
              {kind === 'amount' ? <Check size={17} /> : null}
            </button>
            <button type="button" className={kind === 'paid' ? 'active' : ''} aria-pressed={kind === 'paid'} onClick={() => setKind('paid')}>
              <CheckCircle2 size={18} />
              <span><strong>Already paid</strong><small>Ask them to close this entry</small></span>
              {kind === 'paid' ? <Check size={17} /> : null}
            </button>
          </div>

          {kind === 'amount' ? (
            <label className="review-field">
              Correct amount
              <div className="money-input">
                <span>₹</span>
                <input
                  value={amount}
                  onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))}
                  inputMode="decimal"
                  autoFocus
                />
              </div>
            </label>
          ) : null}

          <label className="review-field">
            Note <span>(optional)</span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value.slice(0, 280))}
              placeholder={kind === 'amount' ? 'Explain what looks wrong…' : 'Mention when or how you paid…'}
              rows={3}
            />
          </label>
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
            <button className="danger-button" type="submit" disabled={working}>{working ? 'Deleting…' : 'Delete due'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

function PersonDrawer({
  summary,
  direction,
  pendingReviews,
  resolvingReviewId,
  onClose,
  onAddDue,
  onDeleteDue,
  onSettle,
  onRequestReview,
  onResolveReview,
}: {
  summary: ContactSummary
  direction: Direction
  pendingReviews: Map<string, LedgerReview>
  resolvingReviewId: string | null
  onClose: () => void
  onAddDue: (person: Person) => void
  onDeleteDue: (entry: LedgerEntry) => void
  onSettle: (id: string) => void
  onRequestReview: (entry: LedgerEntry) => void
  onResolveReview: (review: LedgerReview, entry: LedgerEntry, decision: 'approved' | 'rejected') => void
}) {
  const openDueEntries = summary.entries.filter((entry) => entry.status === 'open')
  const firstName = summary.person.name.split(' ')[0]

  return (
    <div className="drawer-backdrop" onMouseDown={onClose} role="presentation">
      <aside className="person-drawer" role="dialog" aria-modal="true" aria-labelledby="person-ledger-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="drawer-topbar">
          <button className="drawer-back" onClick={onClose} aria-label="Close details"><ChevronLeft size={20} /></button>
          <div className="drawer-person-title">
            <Avatar person={summary.person} size="sm" />
            <span>
              <strong id="person-ledger-title">{summary.person.name}</strong>
              <small>{formatPhone(summary.person.phone)}</small>
            </span>
          </div>
          {direction === 'receivable' ? (
            <button className="drawer-quick-add" type="button" onClick={() => onAddDue(summary.person)} aria-label={`Add due for ${summary.person.name}`}>
              <Plus size={16} /> Add due
            </button>
          ) : <span className="drawer-topbar-spacer" aria-hidden="true" />}
        </header>
        <section className={`person-balance ${direction}`} aria-label="Open balance">
          <div>
            <span>{direction === 'receivable' ? 'They owe you' : 'You owe them'}</span>
            <small>{summary.openCount} open {summary.openCount === 1 ? 'due' : 'dues'}</small>
          </div>
          <strong className={direction === 'payable' ? 'amount-negative' : ''}>{money.format(summary.total)}</strong>
        </section>
        <div className="drawer-entries">
          <div className="drawer-section-title">
            <div>
              <h3>Open dues</h3>
              <p>{direction === 'receivable' ? `Payments expected from ${firstName}` : `Payments recorded by ${firstName}’s lenders`}</p>
            </div>
            <span>{summary.openCount}</span>
          </div>
          {!summary.openCount ? (
            <div className="drawer-empty-ledger">
              <ReceiptText size={21} />
              <strong>No dues yet</strong>
              <span>{direction === 'receivable' ? `Add first due for ${firstName}.` : 'New dues assigned to you appear here.'}</span>
              {direction === 'receivable' ? <button className="secondary-button" type="button" onClick={() => onAddDue(summary.person)}><Plus size={15} /> Add due</button> : null}
            </div>
          ) : null}
          <div className="drawer-entry-list">
            {openDueEntries.map((entry) => {
              const Icon = methodIcons[entry.method]
              const review = pendingReviews.get(entry.id)
              return (
                <article className="drawer-entry" key={entry.id}>
                  <span className="method-icon"><Icon size={17} /></span>
                  <div className="drawer-entry-copy">
                    <h4>{entry.occasion}</h4>
                    <p>{entry.method} · {shortDate.format(new Date(`${entry.date}T00:00:00`))}{direction === 'payable' ? ` · Recorded by ${entry.lender.name}` : ''}</p>
                  </div>
                  <strong className="drawer-entry-amount">{money.format(entry.amount)}</strong>
                  {entry.screenshots?.length ? (
                    <PaymentScreenshotGallery screenshots={entry.screenshots} />
                  ) : null}
                  {review ? (
                    <div className={`entry-review ${direction}`}>
                      <div>
                        <span className="review-status"><Flag size={13} /> Review pending</span>
                        <strong>
                          {review.kind === 'amount'
                            ? `${entry.borrower.name} says the amount should be ${money.format(review.proposedAmount)}.`
                            : `${entry.borrower.name} says this has already been paid.`}
                        </strong>
                        {review.note ? <p>“{review.note}”</p> : null}
                      </div>
                      {direction === 'receivable' ? (
                        <div className="review-actions">
                          <button type="button" disabled={resolvingReviewId === entry.id} onClick={() => onResolveReview(review, entry, 'rejected')}>Keep as is</button>
                          <button type="button" disabled={resolvingReviewId === entry.id} onClick={() => onResolveReview(review, entry, 'approved')}>
                            {review.kind === 'amount' ? 'Use new amount' : 'Confirm paid'}
                          </button>
                        </div>
                      ) : <small>Waiting for {entry.lender.name} to review this.</small>}
                    </div>
                  ) : null}
                  {direction === 'receivable' ? (
                    <div className="drawer-entry-actions">
                      {!review ? <button className="entry-action" type="button" onClick={() => onSettle(entry.id)}><CheckCircle2 size={16} /> Mark paid</button> : null}
                      <button className="entry-delete-action" type="button" onClick={() => onDeleteDue(entry)} aria-label={`Delete ${entry.occasion} due`}><Trash2 size={15} /> Delete due</button>
                    </div>
                  ) : !review ? (
                    <button className="entry-action report" type="button" onClick={() => onRequestReview(entry)}><Flag size={15} /> Report a mistake</button>
                  ) : null}
                </article>
              )
            })}
          </div>
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
  const [importingContacts, setImportingContacts] = useState(false)
  const [reviewEntry, setReviewEntry] = useState<LedgerEntry | null>(null)
  const [deleteEntryTarget, setDeleteEntryTarget] = useState<LedgerEntry | null>(null)
  const [resolvingReviewId, setResolvingReviewId] = useState<string | null>(null)
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null)
  const [toast, setToast] = useState('')
  const [profileOpen, setProfileOpen] = useState(false)
  const contactPickerAvailable = canPickDeviceContacts()

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
        await ensureTruecallerLedgerClaim(firebaseUser)
        const profile = await getUserProfile(firebaseUser.uid)
        setCurrentUser(profile ?? {
          name: 'My account',
          phone: firebaseUser.phoneNumber ?? '',
        })
      } catch (error) {
        console.error('[auth/profile]', error)
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
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2800)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowAddPerson(false)
        setAddDuePerson(null)
        setReviewEntry(null)
        setDeleteEntryTarget(null)
        setSelectedPhone(null)
        setProfileOpen(false)
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [])

  const userPhone = normalizePhone(currentUser?.phone ?? '')
  const ledgerTotals = useMemo(() => entries.reduce((totals, entry) => {
    if (entry.status !== 'open') return totals
    if (normalizePhone(entry.lender.phone) === userPhone) totals.receivable += entry.amount
    if (normalizePhone(entry.borrower.phone) === userPhone) totals.payable += entry.amount
    return totals
  }, { receivable: 0, payable: 0 }), [entries, userPhone])
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

  const incomingReviewEntries = useMemo(() => entries.filter((entry) => (
    normalizePhone(entry.lender.phone) === userPhone
      && entry.status === 'open'
      && pendingReviews.has(entry.id)
  )), [entries, pendingReviews, userPhone])

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
        entries: [],
      }
      existing.entries.push(entry)
      if (entry.status === 'open') {
        existing.total += entry.amount
        existing.openCount += 1
      }
      if (!existing.latestDate || entry.date > existing.latestDate) existing.latestDate = entry.date
      grouped.set(key, existing)
    })
    return [...grouped.values()]
      .filter((summary) => direction === 'receivable' || summary.openCount > 0)
      .sort((a, b) => b.total - a.total || a.person.name.localeCompare(b.person.name))
  }, [contacts, contactsByPhone, direction, relevantEntries, userPhone])

  const summaries = useMemo(() => {
    const queryText = search.trim().toLowerCase()
    if (!queryText) return allSummaries
    return allSummaries.filter((summary) => (
      summary.person.name.toLowerCase().includes(queryText)
      || normalizePhone(summary.person.phone).includes(queryText.replace(/\D/g, ''))
    ))
  }, [allSummaries, search])

  const openEntries = allSummaries.reduce((sum, item) => sum + item.openCount, 0)
  const selectedSummary = allSummaries.find((item) => normalizePhone(item.person.phone) === selectedPhone)

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
    setContacts([])
    setProfileOpen(false)
  }

  async function saveEntry(entry: LedgerEntry) {
    try {
      if (auth?.currentUser) {
        const creatorUid = auth.currentUser.uid
        await createFirebaseEntry(entry, creatorUid)
        setEntries((currentEntries) => [
          { ...entry, createdBy: creatorUid },
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
      setToast('Could not save this entry. Please try again.')
      throw error
    }
  }

  async function markEntrySettled(id: string) {
    try {
      await settleFirebaseEntry(id)
      setToast('Marked as paid.')
    } catch {
      setToast('Could not update this entry. Please try again.')
    }
  }

  async function deleteDue(entry: LedgerEntry) {
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
    if (reviewEntry?.id === entry.id) setReviewEntry(null)
    setToast('Due deleted from both ledgers.')
  }

  async function sendReviewRequest(entry: LedgerEntry, draft: ReviewDraft) {
    if (!auth?.currentUser) throw new Error('Sign in required')
    await createReviewRequest(entry, auth.currentUser.uid, draft)
    setToast('Sent to the person who recorded this entry for review.')
  }

  async function resolveReview(
    review: LedgerReview,
    entry: LedgerEntry,
    decision: 'approved' | 'rejected',
  ) {
    try {
      setResolvingReviewId(entry.id)
      await resolveReviewRequest(review, entry, decision)
      setToast(decision === 'approved' ? 'Correction approved and ledger updated.' : 'Review closed without changing the entry.')
    } catch {
      setToast('Could not resolve this review request. Please try again.')
    } finally {
      setResolvingReviewId(null)
    }
  }

  function openFirstIncomingReview() {
    const entry = incomingReviewEntries[0]
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
    setShowAddPerson(false)
    setSelectedPhone(phone)
    setDirection('receivable')
    setToast(`${savedContact.name} added. Add first due inside their ledger.`)
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
            <UsersRound size={19} /> People
          </button>
          <button className={view === 'activity' ? 'active' : ''} onClick={() => setView('activity')}>
            <History size={19} /> Activity
          </button>
          <button className={view === 'splits' ? 'active' : ''} onClick={() => setView('splits')}>
            <Split size={19} /> Split payments
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
              className={`icon-button notification-button ${incomingReviewEntries.length ? 'has-notifications' : ''}`}
              aria-label={incomingReviewEntries.length ? `Open ${incomingReviewEntries.length} review ${incomingReviewEntries.length === 1 ? 'request' : 'requests'}` : 'No review requests'}
              onClick={openFirstIncomingReview}
              disabled={!incomingReviewEntries.length}
            >
              <Bell size={19} />
              {incomingReviewEntries.length ? <span /> : null}
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
              <section className="people-workspace">
                <header className="people-hero">
                  <div>
                    <p>Personal ledgers</p>
                    <h1>Money lives with people.</h1>
                  </div>
                  <button
                    className="contact-book-button"
                    type="button"
                    onClick={chooseContacts}
                    disabled={importingContacts}
                  >
                    <span><Contact size={21} /></span>
                    <span><strong>{importingContacts ? 'Opening contacts…' : contactPickerAvailable ? 'Choose contacts' : 'Add person'}</strong><small>{contactPickerAvailable ? 'Use names saved on your phone' : 'Enter name and mobile number'}</small></span>
                    <ChevronRight size={18} />
                  </button>
                </header>

                <div className="balance-switch people-balance-switch" role="tablist" aria-label="Choose ledger side">
                  <button role="tab" aria-selected={direction === 'receivable'} className={direction === 'receivable' ? 'active receive' : ''} onClick={() => setDirection('receivable')}>
                    <span className="switch-icon"><ArrowDownLeft size={19} /></span>
                    <span><small>You owe me</small><strong>{money.format(ledgerTotals.receivable)}</strong></span>
                  </button>
                  <button role="tab" aria-selected={direction === 'payable'} className={direction === 'payable' ? 'active pay' : ''} onClick={() => setDirection('payable')}>
                    <span className="switch-icon"><ArrowUpRight size={19} /></span>
                    <span><small>I owe you</small><strong>{money.format(ledgerTotals.payable)}</strong></span>
                  </button>
                </div>

                <div className="people-toolbar">
                  <div>
                    <h2>{direction === 'receivable' ? 'Your people' : 'People you owe'}</h2>
                    <p>{direction === 'receivable' ? `${allSummaries.length} saved ${allSummaries.length === 1 ? 'person' : 'people'}` : `${openEntries} open ${openEntries === 1 ? 'due' : 'dues'}`}</p>
                  </div>
                  <div className="people-toolbar-actions">
                    <label className="people-search">
                      <Search size={17} />
                      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or number" />
                    </label>
                  </div>
                </div>

                <div className="contact-ledger-grid">
                  {(dataLoading || contactsLoading) ? <div className="ledger-loading">Syncing people and dues…</div> : null}
                  {!dataLoading && !contactsLoading && summaries.map((summary) => {
                    const hasReview = summary.entries.some((entry) => pendingReviews.has(entry.id))
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
                            <small>{summary.openCount ? `${summary.openCount} open` : 'Ready when needed'}</small>
                          </span>
                        </button>
                        <div className="contact-ledger-footer">
                          <button type="button" onClick={() => setSelectedPhone(normalizePhone(summary.person.phone))}>
                            {hasReview ? <><Flag size={14} /> Review pending</> : summary.latestDate ? `Last due ${shortDate.format(new Date(`${summary.latestDate}T00:00:00`))}` : 'Open ledger'}
                          </button>
                          {direction === 'receivable' ? (
                            <button className="quick-due-button" type="button" onClick={() => startAddDue(summary.person)}><Plus size={15} /> Add due</button>
                          ) : (
                            <button className="open-ledger-button" type="button" onClick={() => setSelectedPhone(normalizePhone(summary.person.phone))}>View dues <ChevronRight size={14} /></button>
                          )}
                        </div>
                      </article>
                    )
                  })}
                  {!dataLoading && !contactsLoading && summaries.length === 0 ? (
                    <div className="people-empty-state">
                      <span><Contact size={25} /></span>
                      <h3>{search ? 'No matching person' : direction === 'receivable' ? 'Bring in your people' : 'Nothing to pay back'}</h3>
                      <p>{search ? 'Search another name or mobile number.' : direction === 'receivable' ? 'Choose contacts from your phone, then keep every due inside each person’s ledger.' : 'Dues assigned to your mobile number appear here.'}</p>
                      {!search && direction === 'receivable' ? (
                        <button className="primary-button" type="button" onClick={chooseContacts}><Contact size={17} /> {contactPickerAvailable ? 'Choose contacts' : 'Add person'}</button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </section>
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
                    const entryPerson = direction === 'receivable' ? entry.borrower : entry.lender
                    const person = contactsByPhone.get(normalizePhone(entryPerson.phone)) ?? entryPerson
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
                          <span className={pendingReviews.has(entry.id) ? 'review' : entry.status}>
                            {pendingReviews.has(entry.id) ? 'Review pending' : entry.status === 'settled' ? 'Paid' : 'Open'}
                          </span>
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

        </div>
      </main>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        <button className={view === 'ledger' ? 'active' : ''} onClick={() => setView('ledger')}><UsersRound size={20} /><span>People</span></button>
        <button className={view === 'activity' ? 'active' : ''} onClick={() => setView('activity')}><History size={20} /><span>Activity</span></button>
        <button className={view === 'splits' ? 'active' : ''} onClick={() => setView('splits')}><Split size={20} /><span>Splits</span></button>
      </nav>

      {showAddPerson ? <AddPersonModal onClose={() => setShowAddPerson(false)} onSave={addManualContact} onImport={importDeviceContacts} contactPickerAvailable={contactPickerAvailable} /> : null}
      {selectedSummary && <PersonDrawer
        summary={selectedSummary}
        direction={direction}
        pendingReviews={pendingReviews}
        resolvingReviewId={resolvingReviewId}
        onClose={() => setSelectedPhone(null)}
        onAddDue={startAddDue}
        onDeleteDue={setDeleteEntryTarget}
        onSettle={markEntrySettled}
        onRequestReview={setReviewEntry}
        onResolveReview={resolveReview}
      />}
      {addDuePerson ? <AddEntryModal currentUser={currentUser} contact={addDuePerson} onClose={() => setAddDuePerson(null)} onSave={saveEntry} /> : null}
      {reviewEntry ? <ReviewRequestModal entry={reviewEntry} onClose={() => setReviewEntry(null)} onSend={(draft) => sendReviewRequest(reviewEntry, draft)} /> : null}
      {deleteEntryTarget ? <DeleteDueModal entry={deleteEntryTarget} onClose={() => setDeleteEntryTarget(null)} onDelete={deleteDue} /> : null}
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
