/* The dashboard's calls to the gateway.
 *
 * The admin key is kept in localStorage under "moat.admin", the same slot
 * the classic pages and the shared navigation read, so signing in here signs
 * in everywhere on the site. A key is shown once; losing the slot costs a
 * sign-in, not the key. */

const SLOT = 'moat.admin'

export function held(): string | null {
  try { return localStorage.getItem(SLOT) } catch { return null }
}

export function hold(v: string | null) {
  try { if (v) localStorage.setItem(SLOT, v); else localStorage.removeItem(SLOT) } catch { /* a private window */ }
}

/** A JSON call with `secret` as the bearer key, or the admin key when none is
 *  given. Throws the gateway's own error message on anything but a 2xx. */
export async function call<T = unknown>(path: string, opts: RequestInit = {}, secret = held()): Promise<T> {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(secret ? { authorization: 'Bearer ' + secret } : {}),
      ...(opts.headers || {}),
    },
  })
  const text = await res.text()
  let body: unknown
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!res.ok) {
    const message = typeof body === 'string' ? body : (body as { error?: string } | null)?.error
    throw new Error(message || res.statusText)
  }
  return body as T
}

/* ---- key files ----------------------------------------------------------
   A key is shown once. Saved as a small JSON file it can be kept where
   passwords are kept and used to sign in again, and the same shape is what
   the gateway mails as a recovery key, so one reader handles both. */

/** What a key is for, as the file records it. */
export interface KeyMeta {
  /** The workspace the key opens, when known: a signup or a recovery. */
  workspace?: string
  /** What the key was called when minted. */
  label: string
  /** `admin`, `agent` or `approver`. */
  role: string
}

/** The file for a key: its name and its text. */
export function keyFile(key: string, meta: KeyMeta): { name: string; text: string } {
  const who = (meta.workspace || meta.label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'key'
  const text = JSON.stringify(
    {
      moat_key: 1,
      ...(meta.workspace ? { workspace: meta.workspace } : {}),
      label: meta.label,
      role: meta.role,
      key,
      api: typeof location !== 'undefined' ? location.origin : '',
      issued_at: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n'
  return { name: `moat-${who}-${meta.role}-key.json`, text }
}

/** Hand the browser a file to save. */
export function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** What somebody pasted or uploaded to sign in: a key, or a recovery key,
 *  bare or inside a key file. `null` when it is neither. */
export function readKeyInput(raw: string): { kind: 'admin' | 'recovery'; key: string } | null {
  const text = raw.trim()
  if (!text) return null
  if (text.startsWith('{')) {
    let file: Record<string, unknown>
    try { file = JSON.parse(text) as Record<string, unknown> } catch { return null }
    const recovery = file['recovery_key']
    if (typeof recovery === 'string' && recovery) return { kind: 'recovery', key: recovery.trim() }
    const key = file['key'] ?? file['secret'] ?? file['admin_key']
    if (typeof key === 'string' && key) return { kind: 'admin', key: key.trim() }
    return null
  }
  return { kind: text.startsWith('rk_') ? 'recovery' : 'admin', key: text }
}
