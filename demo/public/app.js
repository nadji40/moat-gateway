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
  btn.innerHTML = '<span class="spinner"></span>' + label;
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
}

function idle(btn) {
  if (btn.dataset.idle !== undefined) btn.innerHTML = btn.dataset.idle;
  btn.disabled = false;
  btn.removeAttribute("aria-busy");
}
