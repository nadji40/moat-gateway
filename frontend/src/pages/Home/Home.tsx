import Hero from './components/Hero'
import ProblemExample from './components/ProblemExample'
import HowItWorks from './components/HowItWorks'
import Results from './components/Results'
import SecurityFeatures from './components/SecurityFeatures'
import MCPIntegration from './components/MCPIntegration'
import SandboxDemo from '../../features/sandbox/SandboxDemo'
import ClosingCTA from './components/ClosingCTA'
import Footer from '../../components/layout/Footer'

export default function Home() {
  return (
    <>
      <div className="wrap">
        <Hero />
        <ProblemExample />
        <HowItWorks />
        <Results />
        <SecurityFeatures />
        <MCPIntegration />
        <SandboxDemo />
        <ClosingCTA />
      </div>
      <Footer />
    </>
  )
}
