import {
  deleteObject,
  getBlob,
  ref,
  uploadBytes,
} from 'firebase/storage'
import { PaymentScreenshot } from './data'
import { storage } from './firebase'

export const MAX_PAYMENT_SCREENSHOTS = 5
export const MAX_SCREENSHOT_SIZE = 6 * 1024 * 1024

export const acceptedScreenshotTypes = [
  'image/jpeg',
  'image/png',
  'image/webp',
]

function requireStorage() {
  if (!storage) throw new Error('Firebase Storage is not configured.')
  return storage
}

function safeFileName(name: string) {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-90)

  return cleaned || 'payment-proof'
}

export async function uploadPaymentScreenshots(
  entryId: string,
  uploaderUid: string,
  files: File[],
  onProgress?: (completed: number, total: number) => void,
): Promise<PaymentScreenshot[]> {
  const uploaded: PaymentScreenshot[] = []

  try {
    for (const [index, file] of files.entries()) {
      const uniqueId = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const fileName = `${index + 1}-${uniqueId}-${safeFileName(file.name)}`
      const path = `ledgerEntries/${entryId}/${uploaderUid}/${fileName}`

      await uploadBytes(ref(requireStorage(), path), file, {
        contentType: file.type,
        cacheControl: 'private,max-age=3600',
        customMetadata: { entryId, uploaderUid },
      })

      uploaded.push({
        path,
        name: file.name.slice(0, 120),
        contentType: file.type,
        size: file.size,
      })
      onProgress?.(uploaded.length, files.length)
    }

    return uploaded
  } catch (error) {
    await deletePaymentScreenshots(uploaded)
    throw error
  }
}

export async function deletePaymentScreenshots(screenshots: PaymentScreenshot[]) {
  await Promise.allSettled(
    screenshots.map((screenshot) => deleteObject(ref(requireStorage(), screenshot.path))),
  )
}

export async function loadPaymentScreenshot(screenshot: PaymentScreenshot) {
  const blob = await getBlob(ref(requireStorage(), screenshot.path), MAX_SCREENSHOT_SIZE + 1)
  return URL.createObjectURL(blob)
}
