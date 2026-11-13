import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initAudio } from './audio'
import { initFx } from './ui/fx'
import { installBridge } from './near/bridge'

initAudio()

// UI scale for the screen: reference 1600×900. 1080p ≈ ×1.2, 1440p ≈ ×1.6, a small laptop ≈ ×0.85.
// Everything scales together (text, panels, cards), like in games. --app-h is the window height in scaled pixels
// (vh (browsers compute vh inside a zoomed element differently, so we compute it ourselves).
function applyUiScale() {
  const s = Math.min(2, Math.max(0.8, Math.min(window.innerWidth / 1600, window.innerHeight / 900)))
  const root = document.documentElement
  root.style.setProperty('--ui-scale', s.toFixed(3))
  root.style.setProperty('--app-h', `${Math.round(window.innerHeight / s)}px`)
}
applyUiScale()
window.addEventListener('resize', applyUiScale)

// Cursor and the "tube" glow under it (ui/fx.ts)
initFx()

// NEAR: mirror the player's trades and battles on-chain when they are logged in (src/near)
installBridge()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
