import { useEffect, useState } from 'react'

const links = [
  { href: '/docs', label: 'Docs', page: 'docs' },
  { href: '/compare', label: 'Compare', page: 'compare' },
  { href: '/tests', label: 'The tests', page: 'tests' },
  { href: '/status', label: 'Status', page: 'status' },
  { href: '/team', label: 'Team', page: 'team' },
]

function Mark() {
  return (
    <svg className="mark" viewBox="69 43 144 144" aria-hidden="true">
      <g className="e-ring">
        <g fill="none" stroke="currentColor" strokeWidth="10" strokeLinecap="round">
          <path className="arc" pathLength="1" d="M117 52.4 A67 67 0 0 1 202.7 141.2" />
          <path className="arc two" pathLength="1" d="M177.5 171.2 A67 67 0 0 1 86.1 76.6" />
        </g>
        <g fill="currentColor"><circle className="dot" cx="99.7" cy="62.2" r="11" /><circle className="dot two" cx="192.3" cy="158.1" r="11" /></g>
      </g>
      <path className="body e-front" fill="currentColor" fillRule="evenodd" d="M110 90 H173 A7 7 0 0 1 180 97 V133 A7 7 0 0 1 173 140 H110 A7 7 0 0 1 103 133 V97 A7 7 0 0 1 110 90 Z M115 105 H123 A2 2 0 0 1 125 107 V112 A2 2 0 0 1 123 114 H115 A2 2 0 0 1 113 112 V107 A2 2 0 0 1 115 105 Z" />
      <g className="e-back" fill="currentColor">
        <path d="M110 90 H173 A7 7 0 0 1 180 97 V100 H103 V97 A7 7 0 0 1 110 90 Z" />
        <path fillRule="evenodd" d="M103 110 H180 V133 A7 7 0 0 1 173 140 H110 A7 7 0 0 1 103 133 Z M112 118 H148 A2 2 0 0 1 150 120 V124 A2 2 0 0 1 148 126 H112 A2 2 0 0 1 110 124 V120 A2 2 0 0 1 112 118 Z" />
      </g>
    </svg>
  )
}

export default function Navbar() {
  const [open, setOpen] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const current = location.pathname.replace(/\/+$/, '').split('/').pop() || 'index'

  useEffect(() => {
    try { setSignedIn(Boolean(localStorage.getItem('moat.admin'))) } catch { setSignedIn(false) }
    const close = () => setOpen(false)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    addEventListener('click', close)
    addEventListener('keydown', escape)
    return () => { removeEventListener('click', close); removeEventListener('keydown', escape) }
  }, [])

  return (
    <nav aria-label="Main" data-open={open || undefined}>
      <div className="wrap">
        <div className="navbar glass">
          <a className="navmark" href="/" aria-label="moat, home" onClick={() => setOpen(false)}><Mark /></a>
          <div className="navlinks" id="navlinks">
            {links.map((link) => (
              <a key={link.href} href={link.href} aria-current={link.page === current ? 'page' : undefined} onClick={() => setOpen(false)}>
                {link.label}
              </a>
            ))}
          </div>
          <button
            className="navtoggle"
            type="button"
            aria-controls="navlinks"
            aria-expanded={open}
            aria-label="Pages"
            onClick={(event) => { event.stopPropagation(); setOpen((value) => !value) }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path className="i-open" d="M4 7h16M4 12h16M4 17h16" />
              <path className="i-shut" d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
          <a id="auth" className="btn tiny" href="/dashboard" aria-current={current === 'dashboard' ? 'page' : undefined}>
            {signedIn ? 'Dashboard' : 'Log in'}
          </a>
        </div>
      </div>
    </nav>
  )
}
