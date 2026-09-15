# TallyBack

TallyBack is a lightweight shared ledger for money borrowed, lent, and split between people you know.

## What it includes

- Phone-number-only sign-in with Firebase SMS OTP.
- Automatic Truecaller sign-in on supported Android browsers, with SMS as fallback and no separate login button.
- **You owe me** and **I owe you** ledgers shared by the two mobile numbers on each entry.
- People-first contact book with Android device-contact import and manual fallback.
- One ledger per person, with every due added inside that person instead of re-entering contact details.
- Multiple dues per person with amount, occasion, payment method, date, and settlement status.
- Up to five private payment screenshots per entry, shared only with that entry's participants.
- Split-payment owner workspace for creating a collection, adding members, copying its public link, and recording offline payments.
- Public `/split/:id` payment pages with live progress and Razorpay Checkout.
- Automatic ledger entries for every split member; a successful or owner-recorded payment settles the linked entry.

## Architecture

The Vite/React client is hosted by Firebase Hosting. Firebase Authentication and Cloud Firestore provide identity and live data. Each user's saved people live under `users/{uid}/contacts`. Firebase Storage keeps payment screenshots private behind participant-only rules. The server-only Truecaller callback, Firebase custom-token minting, and Razorpay signature verification run in the `tallyback-server` Vercel project under the Aakash Vercel account.

Contact numbers are stored under each split's private `contacts` subcollection. The public split document contains only display names, share amounts, and payment status. Firestore rules scope the ledger to participants and the split editor to its owner.

On Android, TallyBack prewarms the Truecaller request while authentication loads. A transparent one-use activation layer then launches the prepared deep link from the first real touch, satisfying Chrome's requirement that external apps open from a user gesture without exposing a separate Truecaller button.

## Local setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Fill the Firebase Web app values in `.env.local` and set:

```text
VITE_API_BASE=https://tallyback-server.vercel.app
```

Payment-proof previews use authenticated browser downloads. Apply `storage.cors.json` to the Firebase bucket when adding a new web origin.

Device contacts use the browser Contact Picker API. Supported Android browsers ask users to choose which contacts to share; selected names and mobile numbers then remain saved in TallyBack. Other browsers use manual contact entry.

## Provider setup

### Truecaller

Create a **Web** application in the Truecaller developer console with:

- App name: `TallyBack`
- App domain: `tally-back.web.app`
- Callback URL: `https://tallyback-server.vercel.app/api/truecaller/callback`

Then add the generated key to the production Vercel project:

```bash
vercel env add TRUECALLER_PARTNER_KEY production
vercel env add TRUECALLER_PARTNER_NAME production
```

Redeploy the API after adding the key. Truecaller mobile-web verification runs on Android; other devices use the SMS path.

### Razorpay

Add the merchant credentials to the production Vercel project:

```bash
vercel env add RAZORPAY_KEY_ID production
vercel env add RAZORPAY_KEY_SECRET production
vercel env add RAZORPAY_WEBHOOK_SECRET production
```

Create a Razorpay webhook for `payment.captured` and `order.paid` at:

```text
https://tallyback-server.vercel.app/api/razorpay-webhook
```

Use the same webhook secret in Razorpay and Vercel, then redeploy the API.

## Verification and deployment

```bash
npm run build
firebase deploy --project tally-back --only firestore:rules,storage,hosting
vercel deploy --prod
```

Production URLs:

- App: <https://tally-back.web.app>
- API health: <https://tallyback-server.vercel.app/api/health>
