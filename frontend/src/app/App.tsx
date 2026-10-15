import Home from '../pages/Home/Home'
import Compare from '../pages/Compare/Compare'
import Docs from '../pages/Docs/Docs'
import Team from '../pages/Team/Team'
import Navbar from '../components/layout/Navbar'
import type { ComponentType } from 'react'

const pages: Record<string, ComponentType> = {
  '/compare': Compare,
  '/docs': Docs,
  '/team': Team,
}

export default function App() {
  const path = location.pathname.replace(/\/+$/, '') || '/'
  const Page = pages[path] ?? Home
  return (
    <>
      <Navbar />
      <Page />
    </>
  )
}
