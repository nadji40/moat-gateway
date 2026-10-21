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
