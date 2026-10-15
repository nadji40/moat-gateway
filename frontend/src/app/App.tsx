import Home from '../pages/Home/Home'
import Compare from '../pages/Compare/Compare'
import Navbar from '../components/layout/Navbar'

export default function App() {
  const page = location.pathname.replace(/\/+$/, '') || '/'
  return (
    <>
      <Navbar />
      {page === '/compare' ? <Compare /> : <Home />}
    </>
  )
}
