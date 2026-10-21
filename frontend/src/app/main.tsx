import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// All page and layout styles are imported here rather than co-located with
// each page. Vite produces a single CSS bundle shared by both HTML entries
// (index.html, compare/, docs/ and team/). Importing from the shared entry point
// ensures every style is available regardless of which document loads first.
import '../styles/shared.css'
import '../styles/home.css'
import '../styles/footer.css'
import '../styles/compare.css'
import '../styles/docs.css'
import '../styles/team.css'
import '../styles/i18n.css'
import '../styles/tailwind.css'
import App from './App'
import { applyDocumentLang } from '../i18n'

applyDocumentLang()

const root = document.getElementById('root')!
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
