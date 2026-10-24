import { L } from '../../../i18n'
import { Card } from '../../../components/ui/glass/card'

/**
 * ClosingCTA — the "Put Moat in front of your agent" band.
 *
 * A single section with the closing headline and the primary CTA.
 * Content and destination are identical to the original.
 */
export default function ClosingCTA() {
  return (
    <section className="tight">
      <Card material="clear" tint="rgba(200, 65, 90, 0.16)" className="band home-band">
        {/* The deck's last slide: the person with the tablet, on the far
            side, fading into the board. Decoration only. */}
        <div className="home-band-art" aria-hidden="true" />
        <h2 className="home-band-title">
          {L(
            <>Put Moat in front of<br /><span className="gl-grad">your agent</span></>,
            <>ضع Moat أمام<br /><span className="gl-grad">وكيلك</span></>,
          )}
        </h2>
        <div className="row">
          <a className="gl-pill home-band-cta" href="/dashboard">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            {L('Open a workspace', 'افتح مساحة عمل')}
          </a>
        </div>
      </Card>
    </section>
  )
}
