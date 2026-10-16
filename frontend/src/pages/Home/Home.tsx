import Hero from './components/Hero'
import ProblemExample from './components/ProblemExample'
import HowItWorks from './components/HowItWorks'
import SecurityFeatures from './components/SecurityFeatures'
import ClosingCTA from './components/ClosingCTA'
import Footer from '../../components/layout/Footer'

export default function Home() {
  return (
    <>
      <div className="wrap">
        <Hero />
        <ProblemExample />
        <HowItWorks />
        <SecurityFeatures />
        <ClosingCTA />
      </div>
      <Footer />
    </>
  )
}
