// Shared by index.html, tests.html and status.html.
//
// These were hand-copied into all three pages, which is how one of them
// ended up naming its button helper `busy` on the page that already used
// `busy` for the set of tests in flight. One copy cannot drift from itself.

const $ = (s) => document.querySelector(s);
const NL = String.fromCharCode(10);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function api(p, o) {
  const r = await fetch(p, o);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}

const CARD_PATH = "M110 90 H173 A7 7 0 0 1 180 97 V133 A7 7 0 0 1 173 140 H110 A7 7 0 0 1 103 133 V97 A7 7 0 0 1 110 90 Z M115 105 H123 A2 2 0 0 1 125 107 V112 A2 2 0 0 1 123 114 H115 A2 2 0 0 1 113 112 V107 A2 2 0 0 1 115 105 Z";

/**
 * Work in progress, drawn as the mark itself: the arcs spin and breathe
 * while the dots counter-rotate around a card that stays put.
 *
 * The reference also sweeps a scan line across the card. At the size this
 * renders inside a button the card is about six pixels wide, so the scan
 * would be invisible, and it needed a gradient the rest of the page does
 * not use. Left out rather than shipped unseen.
 */
const PLAY =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<polygon points="6 3 20 12 6 21 6 3"/></svg>';

const SPINNER =
  '<svg class="spin-mark" viewBox="69 43 144 144" aria-hidden="true">' +
  '<g class="s-arcs" fill="none" stroke="currentColor" stroke-width="13" stroke-linecap="round">' +
  '<path class="s-arc" pathLength="100" d="M117 52.4 A67 67 0 0 1 202.7 141.2"/>' +
  '<path class="s-arc" pathLength="100" d="M177.5 171.2 A67 67 0 0 1 86.1 76.6"/></g>' +
  '<g class="s-dots" fill="currentColor"><circle cx="99.7" cy="62.2" r="12"/><circle cx="192.3" cy="158.1" r="12"/></g>' +
  '<path fill="currentColor" fill-rule="evenodd" d="' + CARD_PATH + '"/></svg>';

/**
 * A control that is working says so on itself.
 *
 * Disabling a button without that reads as a broken control: dimmed,
 * pressed down onto its own edge, with a spinner orphaned beside it. The
 * `aria-busy` rule in app.css keeps it at full brightness and standing at
 * its normal height, so the only thing that changes is that it is spinning.
 * It stays unclickable, because it is disabled too.
 */
function working(btn, label) {
  if (btn.dataset.idle === undefined) btn.dataset.idle = btn.innerHTML;
  btn.innerHTML = SPINNER + label;
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
}

function idle(btn) {
  if (btn.dataset.idle !== undefined) btn.innerHTML = btn.dataset.idle;
  btn.disabled = false;
  btn.removeAttribute("aria-busy");
}

/**
 * Copy to the clipboard and say so on the button that did it.
 *
 * execCommand is the fallback because the async clipboard API needs a
 * secure context, and this page is reachable over plain http on a LAN.
 */
async function copyText(text, btn, done = "Copied", selectOnFail) {
  let ok = false;
  // The async API is refused in more places than the docs suggest: an
  // embedded browser, a denied permission, a page without focus. A throw
  // from it has to fall through to the old way rather than end the attempt.
  try {
    if (navigator.clipboard && isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch { ok = false; }
  if (!ok) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:0;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    } catch { ok = false; }
  }
  // If the clipboard is refused, do not just tell them to press ctrl C:
  // put the text under a selection so that pressing it actually works.
  if (!ok && selectOnFail) {
    const r = document.createRange();
    r.selectNodeContents(selectOnFail);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  if (!btn) return ok;
  const was = btn.dataset.said ?? btn.innerHTML;
  btn.dataset.said = was;
  btn.innerHTML = ok ? done : "Press ctrl C";
  clearTimeout(btn._t);
  btn._t = setTimeout(() => { btn.innerHTML = was; delete btn.dataset.said; }, 1600);
  return ok;
}

/* ------------------------------------------------------------------ nav ---
   The way into the dashboard, on every page. Two states, one place: signed
   out it says Log in, signed in it says Dashboard and lights its dot. It is
   built here rather than written into each page's markup so the two states
   cannot drift apart, and so it survives on phones, where .navlinks is
   hidden and a text link in there would vanish. */
const ADMIN_SLOT = "moat.admin";

function signedIn() {
  try { return Boolean(sessionStorage.getItem(ADMIN_SLOT)); } catch { return false; }
}

function mountAuthButton() {
  const bar = document.querySelector(".navbar");
  if (!bar) return;
  // Idempotent on purpose: signing in and out happens after the page has
  // loaded, so this is also how the button is brought up to date. Mounting
  // once and never looking again left the header saying Log in while the
  // workspace was open behind it.
  let a = document.getElementById("auth");
  if (!a) {
    a = document.createElement("a");
    a.id = "auth";
    a.href = "dashboard.html";
    bar.insertBefore(a, document.getElementById("live"));
  }
  const inn = signedIn();
  a.className = "statusbtn" + (inn ? " on" : "");
  a.innerHTML = '<b></b><span>' + (inn ? "Dashboard" : "Log in") + '</span>';
  if (location.pathname.endsWith("dashboard.html")) a.setAttribute("aria-current", "page");
}

/* A pair of tabs over a deck of slides, as the front page uses for the rails.
   Returns its own resize, because a deck inside something hidden measures as
   zero and has to be told to measure again once it is on screen. */
function mountSwiper(barSel, deckSel) {
  const bar = document.querySelector(barSel);
  const deck = document.querySelector(deckSel);
  if (!bar || !deck) return null;
  const tabs = [...bar.querySelectorAll("[role=tab]")];
  const slides = [...deck.querySelectorAll(".slide")];
  const thumb = bar.querySelector(".thumb");
  if (!tabs.length || !slides.length || !thumb) return null;
  let active = 0;

  const size = () => { const h = slides[active].offsetHeight; if (h) deck.style.height = h + "px"; };

  function show(i, focus) {
    active = Math.max(0, Math.min(slides.length - 1, i));
    slides.forEach((s, n) => {
      s.classList.toggle("on", n === active);
      // leaving slides pull back the way they came, so the motion has a direction
      s.style.setProperty("--x", n === active ? "0px" : (n < active ? "-30px" : "30px"));
    });
    tabs.forEach((t, n) => t.setAttribute("aria-selected", String(n === active)));
    const t = tabs[active];
    thumb.style.width = t.offsetWidth + "px";
    thumb.style.transform = "translateX(" + (t.offsetLeft - 4) + "px)";
    size();
    if (focus) t.focus();
  }

  tabs.forEach((t, i) => {
    t.addEventListener("click", () => show(i));
    t.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        show(active + (e.key === "ArrowRight" ? 1 : -1), true);
      }
    });
  });
  addEventListener("resize", size);
  show(0);
  return { show, size };
}

mountAuthButton();
