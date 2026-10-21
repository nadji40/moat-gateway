/* Moat console — sliding menubar thumb.
   Grafted from components/sliding-tabs.js (the "Off chain / On chain" pill):
   an orange chip that slides between the bar's tabs with the component's
   cubic-bezier(.2,.7,.2,1) physics. State stays owned by shared.js (.active);
   this file only mirrors it onto the thumb. Without this file (or under
   reduced motion) the static orange active chip remains exactly as before.
   Tab clicks are DELEGATED at bar level and buttons are looked up LIVE
   (not snapshotted), so bars whose buttons shared.js rebuilds after mount
   (verdicts pagination) keep a working thumb. */
(function () {
  "use strict";

  var PAD = 6; // .menubar padding

  function mountBar(bar) {
    if (!bar.querySelector("button")) return;
    function liveTabs() { return Array.prototype.slice.call(bar.querySelectorAll("button")); }

    // reuse the thumb on rebuilds — only one chip per bar, ever
    var thumb = bar.querySelector(".thumb");
    if (!thumb) {
      thumb = document.createElement("span");
      thumb.className = "thumb";
      thumb.setAttribute("aria-hidden", "true");
    }
    bar.appendChild(thumb); // (re)append keeps it as the last node
    bar.classList.add("sliding");

    function place() {
      var all = liveTabs();
      var cur = bar.querySelector("button.active") || all[0];
      if (!cur) return;
      thumb.style.width = cur.offsetWidth + "px";
      thumb.style.transform = "translateX(" + (cur.offsetLeft - PAD) + "px)";
      all.forEach(function (t) {
        var sel = t === cur;
        t.setAttribute("aria-selected", String(sel));
        t.setAttribute("tabindex", sel ? "0" : "-1");
      });
    }
    function ariaSafe(b) { return !!b; }

    // thumb follows whatever button shared.js marks active — run after click handlers
    bar.addEventListener("click", function () { requestAnimationFrame(place); });

    // keyboard: Arrows/Home/End just activate the neighbouring tab (same pipeline as clicks)
    bar.addEventListener("keydown", function (e) {
      var dir = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      var all = liveTabs();
      var i = all.indexOf(bar.querySelector("button.active") || all[0]);
      var target = null;
      if (dir !== undefined) target = all[(i + dir + all.length) % all.length];
      else if (e.key === "Home") target = all[0];
      else if (e.key === "End") target = all[all.length - 1];
      if (target) {
        e.preventDefault();
        target.click();
        target.focus();
      }
    });

    var onResize = function () { place(); };
    window.addEventListener("resize", onResize);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(onResize);
    if (typeof ResizeObserver === "function") new ResizeObserver(onResize).observe(bar);

    place();
  }

  document.querySelectorAll(".menubar").forEach(mountBar);
})();
