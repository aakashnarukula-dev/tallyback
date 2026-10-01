// The owner's split editor lives at /splits/<slug>; the public payment page stays at /split/<slug>.
const SPLIT_EDITOR_PATH = /^\/splits\/([a-z0-9-]+)\/?$/i

export function splitIdFromEditorPath(pathname: string) {
  return pathname.match(SPLIT_EDITOR_PATH)?.[1] ?? ''
}

export function splitEditorPath(splitId: string) {
  return splitId ? `/splits/${splitId}` : '/splits'
}
