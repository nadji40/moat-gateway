import Hero from './components/Hero'
import HowItWorks from './components/HowItWorks'
import SecurityFeatures from './components/SecurityFeatures'
import DemoVideo from './components/DemoVideo'
import ClosingCTA from './components/ClosingCTA'
import Footer from '../../components/layout/Footer'
import { LiquidGlassProvider } from '../../components/ui/liquid/liquid-glass-provider'

// The same liquid-glass renderer as Compare and Status: one canvas behind the
// page, and every Card on it is drawn as glass.
export default function Home() {
  return (
    <LiquidGlassProvider
      backdrop="/glass-backdrop.svg"
      options={{ refraction: 16, dispersion: 0.035, frost: 8, liquid: false }}
    >
      <div className="wrap">
        <Hero />
        <HowItWorks />
        <SecurityFeatures />
        <DemoVideo />
        <ClosingCTA />
      </div>
      <Footer />
    </LiquidGlassProvider>
  )
}
