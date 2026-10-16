import { L } from '../../../i18n'

/**
 * Hero section — the first thing a visitor sees.
 *
 * Preserves the animated SVG mark, the h1 copy, the lede, and the two
 * primary CTAs exactly as in the original. No content has been changed.
 */
export default function Hero() {
  return (
    <header className="hero">
      <div>
        {/* Animated brand mark. aria-hidden: purely decorative. */}
        <div className="heromark" aria-hidden="true">
          <svg viewBox="69 43 144 144" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <clipPath id="f-clip">
                <circle cx="141" cy="115" r="57" />
              </clipPath>
            </defs>
            <style>{`
              .f-ring{transform-box:view-box;transform-origin:141px 115px;animation:f-ring 3.2s infinite}
              .f-card{transform-box:view-box;transform-origin:141.5px 115px;animation:f-swipe 3.2s infinite}
              @keyframes f-swipe{
                0%,14%{transform:translateX(0) skewX(0deg);animation-timing-function:cubic-bezier(.7,0,.9,.5)}
                38%{transform:translateX(112px) skewX(-14deg)}
                38.01%{transform:translateX(-112px) skewX(-14deg);animation-timing-function:cubic-bezier(.1,.5,.3,1)}
                60%{transform:translateX(5px) skewX(3deg);animation-timing-function:ease-in-out}
                70%,100%{transform:translateX(0) skewX(0deg)}
              }
              @keyframes f-ring{
                0%,14%{transform:rotate(0deg);animation-timing-function:cubic-bezier(.7,0,.3,1)}
                70%,100%{transform:rotate(360deg)}
              }
            `}</style>
            <g className="f-ring">
              <g fill="none" stroke="currentColor" strokeWidth="10" strokeLinecap="round">
                <path d="M117 52.4 A67 67 0 0 1 202.7 141.2" />
                <path d="M177.5 171.2 A67 67 0 0 1 86.1 76.6" />
              </g>
              <g fill="currentColor">
                <circle cx="99.7" cy="62.2" r="11" />
                <circle cx="192.3" cy="158.1" r="11" />
              </g>
            </g>
            <g clipPath="url(#f-clip)">
              <path
                className="f-card"
                fill="currentColor"
                fillRule="evenodd"
                d="M110 90 H173 A7 7 0 0 1 180 97 V133 A7 7 0 0 1 173 140 H110 A7 7 0 0 1 103 133 V97 A7 7 0 0 1 110 90 Z M115 105 H123 A2 2 0 0 1 125 107 V112 A2 2 0 0 1 123 114 H115 A2 2 0 0 1 113 112 V107 A2 2 0 0 1 115 105 Z"
              />
            </g>
          </svg>
        </div>


        <h1>
          {L(
            <>
              Your agent pays only
              <br />
              what <span className="g">you asked for</span>
            </>,
            <>
              وكيلك لا يدفع
              <br />
              إلا <span className="g">ما طلبتَه</span>
            </>,
          )}
        </h1>

        <div className="row">
          <a className="btn" href="/dashboard">
            {L('Open a workspace', 'افتح مساحة عمل')}
          </a>
          <a className="btn ghost" href="/tests?run=1">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <polygon points="6 3 20 12 6 21 6 3" />
            </svg>
            {L('Run the attacks live', 'شغّل الهجمات مباشرة')}
          </a>
        </div>
      </div>
    </header>
  )
}
