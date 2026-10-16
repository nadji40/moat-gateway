import { L } from '../../../i18n'

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
        <h2>{L('Put Moat in front of your agent', 'ضع Moat أمام وكيلك')}</h2>
        <div className="row">
          <a className="btn" href="/dashboard">{L('Open a workspace', 'افتح مساحة عمل')}</a>
        </div>
      </div>
    </section>
  )
}
