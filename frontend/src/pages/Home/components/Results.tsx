/** Arrow SVG shared by the two "more" links below the stat grid. */
function ArrowRight() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"  // decorative — the link label carries the accessible name
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  )
}

/**
 * Results — four performance statistics from real test runs.
 *
 * Numbers are exact copies of the original. No fabrication.
 */
export default function Results() {
  return (
    <section id="numbers" className="tight">
      <div className="head">
        <h2>Measured, not promised.</h2>
      </div>

      <div className="stats4">
        <div className="stat glass">
          <div className="n g">0<small>/ 380</small></div>
          <div className="l">attacks got through</div>
        </div>
        <div className="stat glass">
          <div className="n">135<small>/ 135</small></div>
          <div className="l">honest payments passed</div>
        </div>
        <div className="stat glass">
          <div className="n g">0<small>/ 76</small></div>
          <div className="l">against a real model</div>
        </div>
        <div className="stat glass">
          <div className="n">0.22<small>ms</small></div>
          <div className="l">added per payment</div>
        </div>
      </div>

      <a className="more" href="/compare">
        Compare
        <ArrowRight />
      </a>
      <a className="more" href="/tests">
        The tests
        <ArrowRight />
      </a>
    </section>
  )
}
