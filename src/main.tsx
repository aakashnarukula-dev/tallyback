import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/plus-jakarta-sans'
import '@fontsource-variable/newsreader'
import '@fontsource-variable/manrope'
import '@fontsource-variable/fredoka'
import App from './App'
import './styles.css'
import './splits.css'
import './pastel.css'
import './hybrid.css'
import './performance.css'
import './performance.css'
import './performance.css'
import './performance.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
