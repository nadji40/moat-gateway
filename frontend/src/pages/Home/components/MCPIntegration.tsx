/**
 * MCPIntegration — explains Moat's position as an MCP proxy.
 *
 * Shows the four supported payment rails using the same pill icons and
 * colour tokens as the original. Section ID, heading, and copy are
 * unchanged.
 */
export default function MCPIntegration() {
  return (
    <section id="fit" className="tight">
      <div className="head">
        <h2>Drops in as an MCP proxy.</h2>
        <p>No changes to your agent. Four rails, one policy.</p>
      </div>
 
      <div className="rails" aria-label="Rails">
        {/* Cards */}
        <span className="rail" style={{ ['--c' as string]: 'var(--red-l)' }}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2.6" y="5" width="18.8" height="14" rx="3" />
            <path d="M2.6 9.6h18.8" />
            <path d="M6 14.5h3.5" />
          </svg>
          Cards
        </span>

        {/* Bank transfers */}
        <span className="rail" style={{ ['--c' as string]: 'var(--orange-l)' }}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9.6 12 4.2l9 5.4" />
            <path d="M5.8 11.4v6.2M10 11.4v6.2M14 11.4v6.2M18.2 11.4v6.2" />
            <path d="M3.6 20h16.8" />
          </svg>
          Bank transfers
        </span>

        {/* Ethereum */}
        <span className="rail" style={{ ['--c' as string]: 'var(--yellow-l)' }}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
            <path d="M12 2 5.2 12.1 12 15.9l6.8-3.8z" opacity=".55" />
            <path d="M12 17.2 5.2 13.4 12 22l6.8-8.6z" />
          </svg>
          Ethereum
        </span>

        {/* Solana */}
        <span className="rail" style={{ ['--c' as string]: 'var(--green-l)' }}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
            <path d="M6.8 5.6H20.5L17.2 8.9H3.5z" />
            <path d="M3.5 10.4h13.7l3.3 3.3H6.8z" opacity=".65" />
            <path d="M6.8 15.1H20.5L17.2 18.4H3.5z" />
          </svg>
          Solana
        </span>
      </div>
    </section>
  )
}
