interface Feature {
  icon: React.ReactNode
  title: string
  description: string
}

const FEATURES: Feature[] = [
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </svg>
    ),
    title: 'Payee',
    description: 'From the user, never from a page.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M15 9.5c-.6-1-1.7-1.5-3-1.5-1.7 0-3 .9-3 2.2 0 3 6 1.6 6 4.6 0 1.3-1.3 2.2-3 2.2-1.4 0-2.6-.6-3.1-1.6M12 6v2M12 16v2" />
      </svg>
    ),
    title: 'Amount and currency',
    description: 'Exactly what was asked.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 12l2 2 4-4" />
        <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
      </svg>
    ),
    title: 'Approvals',
    description: 'One approval, one payment.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 19V5M4 19h16" />
        <path d="M8 15l4-4 3 3 5-6" />
      </svg>
    ),
    title: 'Limits',
    description: 'Judged at real value, in any currency.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 6h16M4 12h10M4 18h7" />
        <path d="M17 15l2 2 3-4" />
      </svg>
    ),
    title: 'Languages',
    description: 'English, French and Arabic dialects.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M8 8h8M8 12h8M8 16h5" />
      </svg>
    ),
    title: 'Evidence',
    description: 'A signed record of every verdict.',
  },
]

/**
 * SecurityFeatures — a 3×2 grid of what Moat checks on every payment.
 */
export default function SecurityFeatures() {
  return (
    <section id="checks" className="tight">
      <div className="head">
        <h2>What it checks</h2>
      </div>

      <div className="feats">
        {FEATURES.map((f) => (
          <article key={f.title} className="feat glass">
            <div className="ic">{f.icon}</div>
            <h3>{f.title}</h3>
            <p>{f.description}</p>
          </article>
        ))}
      </div>
    </section>
  )
}
