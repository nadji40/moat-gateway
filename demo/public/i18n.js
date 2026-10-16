/* English and Arabic, for the classic pages (dashboard, tests, status).
 *
 * One setting for the whole site, in localStorage under "moat.lang", so a
 * visitor who picks Arabic on the home page finds the dashboard in Arabic
 * too. `?lang=ar` or `?lang=en` in a link sets it. English is the default.
 *
 * Loaded in <head>, before anything draws, so an Arabic page is right to left
 * from its first frame instead of flipping after it has painted.
 *
 * Text is written in both languages where it is used:
 *   - in markup, the English stays as the element's text and the Arabic goes
 *     in data-ar (data-ar-html when it carries tags, data-ar-ph for a
 *     placeholder, data-ar-aria for aria-label, data-ar-title for title);
 *   - in script, L("English", "عربي") returns the one for the current language.
 * So nothing is looked up by key, and the English a page shows is always the
 * English written next to the Arabic.
 */
(function () {
  const KEY = "moat.lang";
  function detect() {
    try {
      const q = new URLSearchParams(location.search).get("lang");
      if (q === "ar" || q === "en") { localStorage.setItem(KEY, q); return q; }
      const s = localStorage.getItem(KEY);
      if (s === "ar" || s === "en") return s;
    } catch {}
    return "en";
  }
  const lang = detect();
  const ar = lang === "ar";
  const root = document.documentElement;
  root.lang = lang;
  root.dir = ar ? "rtl" : "ltr";
  if (ar) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap";
    document.head.appendChild(link);
  }

  const L = (en, arText) => (ar && arText !== undefined && arText !== null ? arText : en);

  function apply(scope) {
    if (!ar) return;
    const base = scope || document;
    for (const el of base.querySelectorAll("[data-ar]")) el.textContent = el.dataset.ar;
    // Only ever our own markup, written in this repository, never input.
    for (const el of base.querySelectorAll("[data-ar-html]")) el.innerHTML = el.dataset.arHtml;
    for (const el of base.querySelectorAll("[data-ar-ph]")) el.setAttribute("placeholder", el.dataset.arPh);
    for (const el of base.querySelectorAll("[data-ar-aria]")) el.setAttribute("aria-label", el.dataset.arAria);
    for (const el of base.querySelectorAll("[data-ar-title]")) el.setAttribute("title", el.dataset.arTitle);
    const t = document.querySelector("meta[name=ar-title]");
    if (t) document.title = t.getAttribute("content");
  }

  function setLang(next) {
    try { localStorage.setItem(KEY, next); } catch {}
    const u = new URL(location.href);
    u.searchParams.delete("lang");
    location.replace(u.toString());
  }

  window.MOAT_I18N = { lang, ar, L, apply, setLang };
  window.L = L;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => apply());
  else apply();
})();
