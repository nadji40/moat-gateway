import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/shared.css'
import '../styles/glass.css'
import '../styles/home.css'
import '../styles/footer.css'
import '../styles/compare.css'
import '../styles/docs.css'
import '../styles/team.css'
import '../styles/i18n.css'
import '../styles/tailwind.css'
import "../styles/Tests.css";
import App from './App'
import { applyDocumentLang } from '../i18n'

applyDocumentLang()

const root = document.getElementById('root')!
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
