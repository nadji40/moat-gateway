/* English and Arabic for the React pages.
 *
 * The same setting as the classic pages (demo/public/i18n.js): localStorage
 * "moat.lang", set by `?lang=ar` or `?lang=en` in a link, English by default.
 * Text is written in both languages where it is used, with L("English",
 * "عربي"); nothing is looked up by key. Switching reloads the page, so the
 * language never changes under a page that is half drawn. */

export type Lang = 'en' | 'ar'
const KEY = 'moat.lang'

export function lang(): Lang {
  if (typeof window === 'undefined') return 'en'
  try {
    const q = new URLSearchParams(window.location.search).get('lang')
    if (q === 'ar' || q === 'en') { localStorage.setItem(KEY, q); return q }
    const s = localStorage.getItem(KEY)
    if (s === 'ar' || s === 'en') return s
  } catch { /* a private window: English */ }
  return 'en'
}

export const isAr = () => lang() === 'ar'

/** The English or the Arabic, whichever the page is in. */
export function L<T>(en: T, ar: T): T {
  return isAr() ? ar : en
}

export function setLang(next: Lang) {
  try { localStorage.setItem(KEY, next) } catch { /* nothing to remember it in */ }
  const u = new URL(window.location.href)
  u.searchParams.delete('lang')
  window.location.replace(u.toString())
}

/** Direction, language and the Arabic font, before React draws anything. */
export function applyDocumentLang() {
  const ar = isAr()
  const root = document.documentElement
  root.lang = ar ? 'ar' : 'en'
  root.dir = ar ? 'rtl' : 'ltr'
  if (ar && !document.getElementById('font-ar')) {
    const link = document.createElement('link')
    link.id = 'font-ar'
    link.rel = 'stylesheet'
    link.href = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap'
    document.head.appendChild(link)
  }
}
