import { L } from '../../../i18n'
import { Card } from '../../../components/ui/glass/card'

/** DemoVideo — the three-and-a-half-minute demo, on YouTube. */
export default function DemoVideo() {
  return (
    <section id="demo" className="tight">
      <div className="head">
        <h2>{L('See it in action', 'شاهده وهو يعمل')}</h2>
      </div>
      <Card material="clear" tint="rgba(255, 135, 55, 0.10)" className="home-video">
        <div className="home-video-frame">
          <iframe
            src="https://www.youtube.com/embed/ZGURyNnQBCs"
            title={L('Moat demo video', 'فيديو عرض Moat')}
            loading="lazy"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        </div>
      </Card>
    </section>
  )
}
