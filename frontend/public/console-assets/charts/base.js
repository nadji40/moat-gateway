// Shared helpers for the Moat dashboard components (see README.md).
// Needs gsap (optional) for the number-count-up animations; without gsap
// or under prefers-reduced-motion the final value is set directly.
// NOTE: gsap is deliberately NOT loaded in this build (rolled back).
// window.Moat is the chart namespace; shared.js guards on Moat.verdictBarChart.
// exposed: $ (selector), esc (HTML-escape), reducedMotion(), animateCounter.
window.Moat = window.Moat || {};
(function (M) {
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const reducedMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function animateCounter(el, start, end, duration = 0.8, formatter = (v) => Math.round(v).toLocaleString()) {
    if (!el) return;
    if (!window.gsap || reducedMotion()) { el.textContent = formatter(end); return; }
    const obj = { val: start };
    gsap.to(obj, { val: end, duration, ease: "power2.out", onUpdate: () => { el.textContent = formatter(obj.val); } });
  }

  M.$ = $;
  M.esc = esc;
  M.reducedMotion = reducedMotion;
  M.animateCounter = animateCounter;
})(window.Moat);
