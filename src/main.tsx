import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/plus-jakarta-sans'
import '@fontsource-variable/newsreader'
import '@fontsource-variable/manrope'
import '@fontsource-variable/fredoka'
import '@fontsource/poppins/600.css'
import App from './App'
import { auth, db } from './firebase'
import { monitorAuthSessions } from './auth-session'
import './styles.css'
import './splits.css'
import './pastel.css'
import './hybrid.css'
import './performance.css'
import './skeleton.css'

if (auth && db) monitorAuthSessions(auth, db)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
