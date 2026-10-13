import type { ReactNode } from 'react'

type SocialLink = {
  label: string
  href?: string
  Icon: () => ReactNode
}

const socialLinks: SocialLink[] = [
  {
    label: 'LinkedIn',
    href: 'https://www.linkedin.com',
    Icon: () => (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M6.94 8.5A1.56 1.56 0 1 1 6.93 5.4a1.56 1.56 0 0 1 .01 3.1ZM5.5 9.9h2.88v8.6H5.5zm4.7 0h2.76v1.17h.04c.38-.72 1.32-1.48 2.72-1.48 2.9 0 3.43 1.9 3.43 4.38v4.53h-2.88v-4.24c0-1.01-.02-2.3-1.4-2.3s-1.62 1.1-1.62 2.23v4.31H10.2z" fill="currentColor" />
      </svg>
    )
  },
  {
    label: 'WhatsApp',
    href: 'https://www.whatsapp.com/',
    Icon: () => (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12.04 2.2A9.78 9.78 0 0 0 3.4 15.9L2.2 21.4l5.72-1.47a9.8 9.8 0 1 0 4.12-17.73zm5.52 13.9c-.24.67-1.4 1.24-1.93 1.3-.5.07-1.14.1-3.72-.8-3.17-1.1-5.17-3.9-5.33-4.08-.16-.18-1.32-1.76-1.32-3.35 0-1.58 1.02-2.45 1.36-2.78.28-.26.6-.33.8-.33h.57c.18 0 .43.01.67.5.25.52.86 1.8.94 1.93.08.13.14.3.02.47-.12.17-.18.27-.36.43-.18.17-.38.38-.54.52-.18.17-.36.35-.15.72.2.37.9 1.49 1.94 2.41 1.33 1.19 2.45 1.55 2.82 1.73.37.18.6.15.83-.1.23-.25.98-1.14 1.24-1.53.26-.38.52-.32.88-.2.35.12 2.22 1.05 2.6 1.24.38.18.63.27.72.43.09.16.09.9-.15 1.57z" fill="currentColor" />
      </svg>
    )
  },
  {
    label: 'Email',
    Icon: () => (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M3.5 6.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2zm2.2-.5 6.4 5.2 6.5-5.2zm13.8 1.56-6.47 5.26a1 1 0 0 1-1.26 0L5.5 7.56v9.94h13z" fill="currentColor" />
      </svg>
    )
  }
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
              Moat helps AI agents make authorized payments by verifying every action
              against the user&apos;s intent.
            </p>
            <div className="footer-social" aria-label="Moat social links">
              {socialLinks.map(({ label, href, Icon }) => href ? (
                <a
                  key={label}
                  className="social-link"
                  href={href}
                  aria-label={label}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  <Icon />
                </a>
              ) : (
                <span
                  key={label}
                  className="social-link social-link-unavailable"
                  aria-label={`${label} contact unavailable`}
                  title="Email contact unavailable"
                >
                  <Icon />
                </span>
              ))}
            </div>
          </div>

          <div className="footer-group" role="group" aria-labelledby="footer-product">
            <h4 id="footer-product">Product</h4>
            <a href="#how">How it works</a>
            <a href="#checks">What it checks</a>
            <a href="#numbers">Results</a>
            <a href="#api">API</a>
          </div>

          <div className="footer-group" role="group" aria-labelledby="footer-proof">
            <h4 id="footer-proof">Proof</h4>
            <a href="/compare">Compared</a>
            <a href="/tests">The tests</a>
            <a href="/status">Status</a>
          </div>

          <div className="footer-group footer-workspace" role="group" aria-labelledby="footer-workspace">
            <h4 id="footer-workspace">Workspace</h4>
            <a href="/dashboard">Open a workspace</a>
            <a href="/dashboard#pane-playground">Playground</a>
          </div>
        </div>

        <div className="fbase">
          <span>© 2026 Moat</span>
          <span>The sandbox uses a mock provider. No real money moves.</span>
        </div>
      </div>
    </footer>
  )
}
