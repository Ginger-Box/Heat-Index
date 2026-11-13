import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { Boot } from './ui/Boot'
import { initAudio } from './audio'
import { initFx } from './ui/fx'
import { installBridge } from './near/bridge'

initAudio()

// Масштаб интерфейса под экран: эталон 1600×900. На 1080p ≈ ×1,2, на 1440p ≈ ×1,6, на маленьком ноутбуке ≈ ×0,85.
// Масштабируется всё сразу (текст, панели, карты), как в играх. --app-h — высота окна в «масштабированных» пикселях
// (vh внутри элемента с zoom браузеры считают по-разному, поэтому считаем сами).
function applyUiScale() {
  const s = Math.min(2, Math.max(0.8, Math.min(window.innerWidth / 1600, window.innerHeight / 900)))
  const root = document.documentElement
  root.style.setProperty('--ui-scale', s.toFixed(3))
  root.style.setProperty('--app-h', `${Math.round(window.innerHeight / s)}px`)
}
applyUiScale()
window.addEventListener('resize', applyUiScale)

// Курсор и «ламповое» свечение под ним (ui/fx.ts)
initFx()

// NEAR: mirror the player's trades and battles on-chain when they are logged in (src/near)
installBridge()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <Boot />
  </StrictMode>,
)
