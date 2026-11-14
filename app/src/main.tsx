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

// Phones and small tablets: the arena (drag-to-attack, 5 slots, the market table) needs a computer screen
// (a touch screen that is small — a narrow desktop window still gets the game)
const isPhone = window.matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isPhone ? (
      <div className="panel login phone-stub">
        <div className="logo" data-text="HEAT INDEX" style={{ fontSize: 30, marginBottom: 10 }}>
          HEAT INDEX
        </div>
        <p>
          The arena needs a bigger screen. <b>Open this site on a computer</b> to play.
        </p>
        <p className="muted">{location.host}</p>
      </div>
    ) : (
      <App />
    )}
  </StrictMode>,
)
