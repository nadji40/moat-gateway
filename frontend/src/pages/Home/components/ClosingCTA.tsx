/**
 * ClosingCTA — the "Put Moat in front of your agent" band.
 *
 * A single section with the closing headline and the primary CTA.
 * Content and destination are identical to the original.
 */
export default function ClosingCTA() {
  return (
    <section className="tight">
      <div className="band glass">
        <h2>Put Moat in front of your agent.</h2>
        <div className="row">
          <a className="btn" href="/dashboard">Open a workspace</a>
        </div>
      </div>
    </section>
  )
}
