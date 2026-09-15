import {
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  writeBatch,
} from 'firebase/firestore'
import { normalizePhone, Person, SavedContact } from './data'
import { db } from './firebase'
import { toE164 } from './firebase-ledger'

type DeviceContact = {
  name?: string[]
  tel?: string[]
}

type ContactsManager = {
  select(properties: string[], options?: { multiple?: boolean }): Promise<DeviceContact[]>
}

type ContactNavigator = Navigator & {
  contacts?: ContactsManager
}

function requireDatabase() {
  if (!db) throw new Error('Firebase is not configured.')
  return db
}

function indianMobileNumber(value: string) {
  const digits = value.replace(/\D/g, '')
  if (digits.length === 10) return digits
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1)
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2)
  return ''
}

export function canPickDeviceContacts() {
  return Boolean((navigator as ContactNavigator).contacts)
}

export async function pickDeviceContacts(): Promise<Person[]> {
  const contacts = (navigator as ContactNavigator).contacts
  if (!contacts) throw new Error('Device contact picker is unavailable in this browser.')

  const selected = await contacts.select(['name', 'tel'], { multiple: true })
  const people = new Map<string, Person>()

  selected.forEach((contact) => {
    const name = contact.name?.find((value) => value.trim())?.trim().slice(0, 120)
    contact.tel?.forEach((telephone) => {
      const phone = indianMobileNumber(telephone)
      if (!phone) return
      people.set(phone, {
        name: name || `Contact ${phone.slice(-4)}`,
        phone: toE164(phone),
      })
    })
  })

  return [...people.values()]
}

export function subscribeToContacts(
  uid: string,
  onContacts: (contacts: SavedContact[]) => void,
  onError: (error: Error) => void,
) {
  return onSnapshot(
    collection(requireDatabase(), 'users', uid, 'contacts'),
    (snapshot) => onContacts(snapshot.docs.map((contactDoc) => {
      const data = contactDoc.data()
      return {
        name: data.name,
        phone: data.phone,
        source: data.source,
      } as SavedContact
    })),
    onError,
  )
}

export async function saveContact(uid: string, person: Person, source: SavedContact['source']) {
  const phone = normalizePhone(person.phone)
  await setDoc(doc(requireDatabase(), 'users', uid, 'contacts', phone), {
    name: person.name.trim().slice(0, 120),
    phone: toE164(phone),
    source,
    updatedAt: serverTimestamp(),
  })
}

export async function saveContacts(uid: string, people: Person[], source: SavedContact['source']) {
  const database = requireDatabase()

  for (let offset = 0; offset < people.length; offset += 400) {
    const batch = writeBatch(database)
    people.slice(offset, offset + 400).forEach((person) => {
      const phone = normalizePhone(person.phone)
      batch.set(doc(database, 'users', uid, 'contacts', phone), {
        name: person.name.trim().slice(0, 120),
        phone: toE164(phone),
        source,
        updatedAt: serverTimestamp(),
      })
    })
    await batch.commit()
  }
}
