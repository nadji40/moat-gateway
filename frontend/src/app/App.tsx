import { lazy, Suspense } from 'react'
import type { ComponentType } from 'react'

import Home from '../pages/Home/Home'
import Navbar from '../components/layout/Navbar'

const Compare = lazy(() => import('../pages/Compare/Compare'))
const Team = lazy(() => import('../pages/Team/Team'))
const Docs = lazy(() => import('../pages/Docs/Docs'))
const Dashboard = lazy(() => import('../pages/Dashboard/Dashboard'))

const pages: Record<string, ComponentType> = {
  '/compare': Compare,
  '/team': Team,
  '/docs': Docs,
  '/dashboard': Dashboard,
}

export default function App() {
  const rawPath = location.pathname.replace(/\/+$/, '') || '/'

  const path =
    rawPath
      .replace(/\/index\.html$/, '')
      .replace(/\.html$/, '')
      .replace(/\/+$/, '') || '/'

  const Page = pages[path] ?? Home

  return (
    <>
      <Navbar />

      <Suspense
        fallback={
          <main id="main-content" aria-busy="true" />
        }
      >
        <Page />
      </Suspense>
    </>
  )
}
