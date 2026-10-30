import type { ReactNode } from 'react'
import { L } from '../../i18n'

type SocialLink = {
  label: string
  href: string
  Icon: () => ReactNode
}

// Real company links only. An empty list renders nothing; a link to a
// generic site is worse than no link.
const socialLinks: SocialLink[] = [
  {
    label: 'LinkedIn',
    href: 'https://www.linkedin.com/company/moat-gateway/',
    Icon: () => (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
        <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13ZM7.12 20.45H3.56V9h3.56v11.45ZM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0Z" />
      </svg>
    ),
  },
]

export default function Footer() {
  return (
    <footer className="foot">
      <div className="wrap">
        <div className="fcols">
          <div className="fbrand">
            <svg
              className="mark"
              viewBox="69 43 144 144"
              xmlns="http://www.w3.org/2000/svg"
              aria-label="moat"
              role="img"
            >
              <g className="e-ring">
                <g fill="none" stroke="currentColor" strokeWidth="10" strokeLinecap="round">
                  <path className="arc" pathLength="1" d="M117 52.4 A67 67 0 0 1 202.7 141.2" />
                  <path className="arc two" pathLength="1" d="M177.5 171.2 A67 67 0 0 1 86.1 76.6" />
                </g>
                <g fill="currentColor">
                  <circle className="dot" cx="99.7" cy="62.2" r="11" />
                  <circle className="dot two" cx="192.3" cy="158.1" r="11" />
                </g>
              </g>
              <path
                className="body e-front"
                fill="currentColor"
                fillRule="evenodd"
                d="M110 90 H173 A7 7 0 0 1 180 97 V133 A7 7 0 0 1 173 140 H110 A7 7 0 0 1 103 133 V97 A7 7 0 0 1 110 90 Z M115 105 H123 A2 2 0 0 1 125 107 V112 A2 2 0 0 1 123 114 H115 A2 2 0 0 1 113 112 V107 A2 2 0 0 1 115 105 Z"
              />
              <g className="e-back" fill="currentColor">
                <path d="M110 90 H173 A7 7 0 0 1 180 97 V100 H103 V97 A7 7 0 0 1 110 90 Z" />
                <path
                  fillRule="evenodd"
                  d="M103 110 H180 V133 A7 7 0 0 1 173 140 H110 A7 7 0 0 1 103 133 Z M112 118 H148 A2 2 0 0 1 150 120 V124 A2 2 0 0 1 148 126 H112 A2 2 0 0 1 110 124 V120 A2 2 0 0 1 112 118 Z"
                />
              </g>
            </svg>
            <p>
              {L(
                <>
                  Moat helps AI agents make authorized payments by verifying every action
                  against the user&apos;s intent
                </>,
                <>يساعد Moat وكلاء الذكاء الاصطناعي على إجراء دفعات موافَق عليها، بمطابقة كل إجراء مع نية المستخدم</>,
              )}
            </p>
            {socialLinks.length > 0 && (
              <div className="footer-social" aria-label={L('Moat links', 'روابط Moat')}>
                {socialLinks.map(({ label, href, Icon }) => (
                  <a key={label} className="social-link" href={href} aria-label={label} target="_blank" rel="noreferrer noopener">
                    <Icon />
                  </a>
                ))}
              </div>
            )}
          </div>

          <div className="footer-group" role="group" aria-labelledby="footer-product">
            <h4 id="footer-product">{L('Product', 'المنتج')}</h4>
            <a href="/#how">{L('How it works', 'كيف يعمل')}</a>
            <a href="/#checks">{L('What it checks', 'ما الذي يتحقق منه')}</a>
            <a href="/docs">{L('Documentation', 'التوثيق')}</a>
            <a href="/docs#quickstart">{L('API quickstart', 'البدء السريع مع API')}</a>
          </div>

          <div className="footer-group" role="group" aria-labelledby="footer-proof">
            <h4 id="footer-proof">{L('Proof', 'الإثبات')}</h4>
            <a href="/compare">{L('Compared', 'المقارنة')}</a>
            <a href="/tests">{L('The tests', 'الاختبارات')}</a>
            <a href="/status">{L('Status', 'الحالة')}</a>
          </div>

          <div className="footer-group footer-workspace" role="group" aria-labelledby="footer-workspace">
            <h4 id="footer-workspace">{L('Company', 'الشركة')}</h4>
            <a href="/team">{L('Who we are', 'من نحن')}</a>
            <a href="/dashboard">{L('Open a workspace', 'افتح مساحة عمل')}</a>
            <a href="/dashboard#pane-playground">{L('Playground', 'ساحة التجربة')}</a>
          </div>
        </div>

        <div className="fbase">
          <span>© 2026 Moat</span>
        </div>
      </div>
    </footer>
  )
}
