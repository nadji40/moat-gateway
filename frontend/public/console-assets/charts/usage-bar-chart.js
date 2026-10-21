// Verdict stacked bar chart — vanilla port of the simplified <BarChart> component
// (margin { top:8, right:8, bottom:40, left:8 } — no left Y axis, Grid horizontal,
// single Bar with lineCap="round", BarXAxis, ChartTooltip), carrying the three
// verdict statuses stacked bottom→top: Paid (var(--green)), Refused (var(--red)),
// Held (var(--chart-3)) — the badge palette from the design system.
// data = [{ label, allow, step, deny, ... }, ...] (historyDemo points:
// allow = Paid, step = Held for a person, deny = Refused).
//
// layout constants (design-tuned): W 700 × H 220 viewBox that stretches;
// barW = clamp(colStep×0.5, 6..20) — thickened per user request; tiny 3px
// corner round on segments; yScale = max(d.total) rounded up to ×10;
// entrance = CSS bklit-rise (scaleY from baseline, ~18ms/col stagger,
// killed under reduced motion); hover = other columns dim to 35% +
// tooltip (dark card in components.css) reading the stack top→bottom:
// Held, Refused, Paid. MOVE TO A FRAMEWORK: keep the render(host,data)
// contract and the composedPath-free plain listeners.
(function (M) {
  M.verdictBarChart = function (host, data) {
    if (!host || !data || !data.length) return;

    const W = 700, H = 220;
    const padT = 8, padR = 8, padB = 40, padL = 8;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const baseY = padT + plotH;

    // bottom → top of the stack, per the spec
    const STATUSES = [
      { key: "allow", name: "Paid", fill: "var(--green)" },
      { key: "deny", name: "Refused", fill: "var(--red)" },
      { key: "step", name: "Held", fill: "var(--chart-3)" }
    ];

    const maxVal = Math.max(10, Math.ceil(Math.max(...data.map(d => d.total)) / 10) * 10);
    const colStep = plotW / data.length;
    const barW = Math.max(6, Math.min(20, Math.floor(colStep * 0.5)));
    const rx = Math.min(3, barW / 4);

    // horizontal grid only, unlabeled (no Y axis in this shape)
    const grid = [0, 0.5, 1].map(t => {
      const y = padT + plotH * (1 - t);
      return `<line class="bklit-grid-line" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"></line>`;
    }).join("");

    const bars = data.map((d, i) => {
      const colX = padL + i * colStep;
      const x = colX + (colStep - barW) / 2;
      let acc = 0;
      const segs = STATUSES.map(s => {
        const h = (d[s.key] / maxVal) * plotH;
        const y = baseY - acc - h;
        acc += h;
        return `<rect x="${x}" y="${y.toFixed(1)}" width="${barW}" height="${h.toFixed(1)}" fill="${s.fill}" rx="${rx}"></rect>`;
      }).join("");

      const label = (data.length <= 14 || i % 3 === 0)
        ? `<text class="bklit-axis-text" x="${colX + colStep / 2}" y="${H - 12}" text-anchor="middle">${d.label}</text>`
        : "";
      return `
        <g class="bklit-bar-group" data-idx="${i}" style="animation-delay:${Math.min(280, i * 18)}ms">
          ${segs}
          <rect class="bklit-bar-col" x="${colX}" y="${padT}" width="${colStep}" height="${plotH}" fill="transparent" data-idx="${i}"></rect>
          ${label}
        </g>
      `;
    }).join("");

    host.innerHTML = `
      <div class="bklit-bar-wrap">
        <svg class="bklit-bar-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
          ${grid}
          ${bars}
        </svg>
      </div>
      <div class="bklit-tooltip"></div>
    `;

    const svg = host.querySelector(".bklit-bar-svg");
    const tip = host.querySelector(".bklit-tooltip");

    if (svg && tip) {
      svg.querySelectorAll(".bklit-bar-col").forEach(col => {
        col.addEventListener("mouseenter", () => {
          const idx = Number(col.dataset.idx);
          const d = data[idx];
          if (!d) return;

          // dim every other column, highlight this one
          svg.classList.add("dim");
          const g = col.closest(".bklit-bar-group");
          if (g) g.classList.add("hot");

          // tooltip reads top→bottom of the stack: Held, Refused, Paid
          tip.innerHTML = `
            <div class="bklit-tooltip-title">${d.label}</div>
            ${STATUSES.slice().reverse().map(s => `<div class="bklit-tooltip-row"><span class="bklit-tooltip-dot" style="background:${s.fill}"></span> ${s.name}: <b>${d[s.key]}</b></div>`).join("")}
          `;

          const rect = svg.getBoundingClientRect();
          const colCenter = padL + (idx + 0.5) * colStep;
          const tipX = (colCenter / W) * rect.width;
          tip.style.left = `${tipX}px`;
          tip.style.top = `10px`;
          tip.classList.add("on");
        });

        col.addEventListener("mouseleave", () => {
          tip.classList.remove("on");
          svg.classList.remove("dim");
          const g = col.closest(".bklit-bar-group");
          if (g) g.classList.remove("hot");
        });
      });
    }
  };
})(window.Moat);
