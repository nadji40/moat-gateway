import { L } from '../../../i18n'

/**
 * HowItWorks — the animated flow diagram and three verdict cards.
 *
 * The SVG is reproduced faithfully including all keyframes. React JSX
 * requires camelCase for SVG presentation attributes; the values are
 * unchanged. The `<style>` block inside the SVG uses a string template
 * so Vite does not try to process the CSS-inside-SVG.
 */
export default function HowItWorks() {
  return (
    <section id="how" className="tight gl-glow">
      <div className="head">
        <h2>{L('Three answers: under a millisecond', 'ثلاث إجابات: في أقل من ثانية')}</h2>
      </div>

      {/* Flow diagram — aria-hidden because the verdict cards below
          provide the same information in a readable form */}
      <div className="flowart gl-board home-flowboard" aria-hidden="true">
        <svg viewBox="0 0 460 104" xmlns="http://www.w3.org/2000/svg">
          <style>{`
            .a-line{fill:none;stroke:var(--ink-3);stroke-width:2}
            .a-ink{fill:none;stroke:var(--ink-2);stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
            .a-wire{stroke-dasharray:4 7;animation:a-flow 1.3s linear infinite}
            .a-cur{fill:var(--ink-2);animation:a-blink 1.1s steps(1) infinite}
            .a-lbl{fill:var(--ink-3);font-family:var(--font);font-size:11.5px;font-weight:700;letter-spacing:1.6px;text-anchor:middle}
            .a-leg{opacity:0;animation:a-leg 18s cubic-bezier(.55,0,.45,1) infinite}
            .a-gate{transform-box:fill-box;transform-origin:center;animation:a-gate 18s ease-out infinite}
            .a-paid,.a-appr{opacity:0;transform-box:fill-box;transform-origin:center}
            .a-paid{animation:a-paid 18s ease-out infinite}
            .a-appr{animation:a-appr 18s ease-out infinite}
            @keyframes a-flow{to{stroke-dashoffset:-11}}
            @keyframes a-blink{0%,49%{opacity:1}50%,99%{opacity:0}100%{opacity:1}}
            @keyframes a-leg{
              0%{opacity:0;transform:translateX(0)}
              0.6%{opacity:1}
              5%{opacity:1;transform:translateX(var(--d))}
              5.8%,100%{opacity:0;transform:translateX(var(--d))}
            }
            @keyframes a-gate{
              0%,10.3%{transform:scale(1)} 11.6%{transform:scale(1.08)}
              14.5%,34.8%{transform:scale(1)} 36%{transform:scale(1.08)}
              39%,55.9%{transform:scale(1)} 57.2%{transform:scale(1.08)}
              60%,79.2%{transform:scale(1)} 80.5%{transform:scale(1.08)}
              83.5%,100%{transform:scale(1)}
            }
            @keyframes a-paid{
              0%,16.3%{opacity:0;transform:scale(.7)} 17.5%{opacity:1;transform:scale(1)}
              25%{opacity:1} 28%{opacity:0}
              85.2%{opacity:0;transform:scale(.7)} 86.4%{opacity:1;transform:scale(1)}
              94%{opacity:1} 97%,100%{opacity:0}
            }
            @keyframes a-appr{
              0%,66.8%{opacity:0;transform:scale(.7)} 68%{opacity:1;transform:scale(1)}
              76%{opacity:1} 79%,100%{opacity:0}
            }
          `}</style>

          {/* Wires */}
          <line className="a-line a-wire" x1="70"  y1="52" x2="112" y2="52" />
          <line className="a-line a-wire" x1="182" y1="52" x2="230" y2="52" />
          <line className="a-line a-wire" x1="294" y1="52" x2="348" y2="52" />

          {/* You */}
          <rect className="a-line" x="10" y="30" width="54" height="44" rx="13" />
          <circle cx="37" cy="45" r="6" fill="none" stroke="var(--ink-2)" strokeWidth="2.4" />
          <path className="a-ink" d="M27 64 a10 10 0 0 1 20 0" />
          <text className="a-lbl" x="37" y="94">{L('YOU', 'أنت')}</text>

          {/* The agent */}
          <rect className="a-line" x="118" y="30" width="58" height="44" rx="13" />
          <path className="a-ink" d="M132 46 l7 6 -7 6" />
          <rect className="a-cur" x="143" y="56" width="12" height="2.6" rx="1.3" />
          <text className="a-lbl" x="147" y="94">{L('AGENT', 'الوكيل')}</text>

          {/* Moat label */}
          <text className="a-lbl" x="262" y="94">MOAT</text>

          {/* The payee */}
          <rect className="a-line" x="354" y="30" width="54" height="44" rx="13" />
          <rect x="366" y="42" width="30" height="20" rx="4" fill="none" stroke="var(--ink-2)" strokeWidth="2.2" />
          <path className="a-ink" d="M366 49 H396" />
          <text className="a-lbl" x="381" y="94">{L('PAYEE', 'المستفيد')}</text>

          {/* Act one: allowed → payee paid */}
          <g className="a-leg" style={{ ['--d' as string]: '26px', animationDelay: '.2s' }}>
            <rect x="70"  y="48" width="16" height="8" rx="4" fill="var(--ink-2)" />
          </g>
          <g className="a-leg" style={{ ['--d' as string]: '32px', animationDelay: '1.1s' }}>
            <rect x="182" y="48" width="16" height="8" rx="4" fill="var(--ink-2)" />
          </g>
          <g className="a-leg" style={{ ['--d' as string]: '38px', animationDelay: '2.1s' }}>
            <rect x="294" y="48" width="16" height="8" rx="4" fill="var(--green-l)" />
          </g>

          {/* Act two: refused at the gate */}
          <g className="a-leg" style={{ ['--d' as string]: '26px', animationDelay: '4.6s' }}>
            <rect x="70"  y="48" width="16" height="8" rx="4" fill="var(--ink-2)" />
          </g>
          <g className="a-leg" style={{ ['--d' as string]: '32px', animationDelay: '5.5s' }}>
            <rect x="182" y="48" width="16" height="8" rx="4" fill="var(--ink-2)" />
          </g>
          <g className="a-leg" style={{ ['--d' as string]: '-32px', animationDelay: '6.5s' }}>
            <rect x="214" y="48" width="16" height="8" rx="4" fill="var(--red-l)" />
          </g>

          {/* Act three: held → you approve → paid */}
          <g className="a-leg" style={{ ['--d' as string]: '26px',  animationDelay: '8.4s' }}>
            <rect x="70"  y="48" width="16" height="8" rx="4" fill="var(--ink-2)" />
          </g>
          <g className="a-leg" style={{ ['--d' as string]: '32px',  animationDelay: '9.3s' }}>
            <rect x="182" y="48" width="16" height="8" rx="4" fill="var(--ink-2)" />
          </g>
          <g className="a-leg" style={{ ['--d' as string]: '-32px', animationDelay: '10.3s' }}>
            <rect x="214" y="48" width="16" height="8" rx="4" fill="var(--yellow-l)" />
          </g>
          <g className="a-leg" style={{ ['--d' as string]: '-26px', animationDelay: '11.2s' }}>
            <rect x="96"  y="48" width="16" height="8" rx="4" fill="var(--yellow-l)" />
          </g>
          <g className="a-leg" style={{ ['--d' as string]: '26px',  animationDelay: '12.6s' }}>
            <rect x="70"  y="48" width="16" height="8" rx="4" fill="var(--green-l)" />
          </g>
          <g className="a-leg" style={{ ['--d' as string]: '32px',  animationDelay: '13.5s' }}>
            <rect x="182" y="48" width="16" height="8" rx="4" fill="var(--green-l)" />
          </g>
          <g className="a-leg" style={{ ['--d' as string]: '38px',  animationDelay: '14.5s' }}>
            <rect x="294" y="48" width="16" height="8" rx="4" fill="var(--green-l)" />
          </g>

          {/* The gate mark */}
          <g transform="translate(207.28,7.37) scale(0.3881)">
            <g className="a-gate">
              <g fill="none" stroke="var(--ink)" strokeWidth="10" strokeLinecap="round">
                <path d="M117 52.4 A67 67 0 0 1 202.7 141.2" />
                <path d="M177.5 171.2 A67 67 0 0 1 86.1 76.6" />
              </g>
              <g fill="var(--ink)">
                <circle cx="99.7" cy="62.2" r="11" />
                <circle cx="192.3" cy="158.1" r="11" />
              </g>
            </g>
          </g>

          {/* Approval check mark on YOU */}
          <g className="a-appr">
            <circle cx="60" cy="34" r="8.5" fill="var(--green-l)" />
            <path d="M56.2 34 l2.6 2.6 4.4 -4.8" fill="none" stroke="#000" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </g>

          {/* Check mark on PAYEE once paid */}
          <g className="a-paid">
            <circle cx="404" cy="34" r="8.5" fill="var(--green-l)" />
            <path d="M400.2 34 l2.6 2.6 4.4 -4.8" fill="none" stroke="#000" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </g>
        </svg>
      </div>

      {/* Verdict cards: one case at a time, the one the diagram above is
          playing (the same 18 s loop: allowed, then refused, then held and
          approved). All three stay in the page for screen readers; the
          example rows are illustration and are hidden from them. */}
      <div className="verdict3">
        <article className="vcard glass gl-card v-allow">
          <div className="vc-top">
            <span className="vc-ic" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M8 12.3l2.7 2.7L16 9.6" /></svg>
            </span>
            <span className="pill allow">{L('Allowed', 'مسموح بها')}</span>
          </div>
          <p className="vc-rule">{L('It matches what was asked', 'تطابق ما طُلب')}</p>
          <div className="vc-case" aria-hidden="true">
            <span className="vc-who">Atlas Supplies</span>
            <span className="vc-amt">480 USD</span>
            <span className="vc-out">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
              {L('Paid', 'مدفوعة')}
            </span>
          </div>
        </article>
        <article className="vcard glass gl-card v-hold">
          <div className="vc-top">
            <span className="vc-ic" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M10 9v6M14 9v6" /></svg>
            </span>
            <span className="pill step_up">{L('Held', 'مُعلَّقة')}</span>
          </div>
          <p className="vc-rule">{L('Unclear, so a person decides', 'غير واضحة، فيحسمها شخص')}</p>
          <div className="vc-case" aria-hidden="true">
            <span className="vc-who">{L('New supplier', 'مورّد جديد')}</span>
            <span className="vc-amt">480 USD</span>
            <span className="vc-out">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="3.6" /><path d="M5 20a7 7 0 0 1 14 0" /></svg>
              {L('Waits for a person', 'بانتظار شخص')}
            </span>
          </div>
        </article>
        <article className="vcard glass gl-card v-deny">
          <div className="vc-top">
            <span className="vc-ic" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></svg>
            </span>
            <span className="pill deny">{L('Refused', 'مرفوضة')}</span>
          </div>
          <p className="vc-rule">{L('Nobody with the right asked for it', 'لم يطلبها أحد يملك الصلاحية')}</p>
          <div className="vc-case" aria-hidden="true">
            <span className="vc-who">Nova Studio</span>
            <span className="vc-amt">480 USD</span>
            <span className="vc-out">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              {L('Stopped', 'أُوقفت')}
            </span>
          </div>
        </article>
      </div>
    </section>
  )
}
