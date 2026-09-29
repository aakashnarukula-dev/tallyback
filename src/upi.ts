const UPI_ID_PATTERN = /^[A-Za-z0-9._-]{2,}@[A-Za-z][A-Za-z0-9.-]{1,}$/

export function normalizeUpiId(value: string) {
  return value.trim().replace(/\s+/g, '')
}

export function isValidUpiId(value: string) {
  const upiId = normalizeUpiId(value)
  return upiId.length >= 5 && upiId.length <= 100 && UPI_ID_PATTERN.test(upiId)
}

// Standard UPI deep link (NPCI "upi://pay"). Opens any installed UPI app with
// the payee and amount filled in; the money moves bank to bank with no fees.
export function buildUpiPaymentLink({
  upiId,
  payeeName,
  amount,
  note,
}: {
  upiId: string
  payeeName: string
  amount?: number
  note?: string
}) {
  const params: Array<[string, string]> = [
    ['pa', normalizeUpiId(upiId)],
    ['pn', payeeName.trim().slice(0, 50) || 'TallyBack friend'],
  ]
  if (amount && Number.isFinite(amount) && amount > 0) params.push(['am', amount.toFixed(2)])
  params.push(['cu', 'INR'])
  const cleanNote = note?.trim().slice(0, 50)
  if (cleanNote) params.push(['tn', cleanNote])
  // encodeURIComponent keeps spaces as %20; several UPI apps misread "+".
  return `upi://pay?${params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`
}
