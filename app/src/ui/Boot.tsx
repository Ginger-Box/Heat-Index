// Loading screen like an old CRT TV: standby ("press any key to power on") → the tube switches on with a thump
// → a "BIOS" boots the arena (beep, ticks, OK blips) → the picture collapses.
// The standby step is needed for sound: browsers only allow audio after the first click/keypress.
// After power-on any click or key skips it. Lives outside the game (rendered next to <App/>), disappears when done.
// Everything on screen is derived from the elapsed time, so it is deterministic and easy to tune.

import { useEffect, useRef, useState } from 'react';
import { bootSound } from '../audio';

const TASKS = [
  'INITIALIZING NEON TUBES',
  'MOUNTING SCRAPYARD DRIVE',
  'LOADING ARENA PROTOCOLS',
  'SPAWNING 12 NPC TEAMS',
  'WAKING UP AI BROKERS (3)',
  'SYNCING MARKET FEED',
  'CALIBRATING OVERHEAT SENSORS',
];
const ON_MS = 380; // tube switch-on
const MEM_MS = 520; // memory test counter
const TASK_MS = 300; // per task
const TASKS_START = ON_MS + MEM_MS;
const BOOT_END = TASKS_START + TASKS.length * TASK_MS + 250;
const OFF_MS = 330; // tube switch-off
const SPIN = ['|', '/', '-', '\\'];

export function Boot() {
  const [t, setT] = useState(0); // ms since power-on
  const [skipAt, setSkipAt] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const [powered, setPowered] = useState(false);
  const start = useRef(performance.now());
  const played = useRef({ beep: false, ticks: 0, oks: 0, off: false });
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // standby: the first click/key "turns the TV on" (and unlocks sound)
  useEffect(() => {
    if (powered || done) return;
    const on = () => {
      start.current = performance.now();
      setPowered(true);
      // the audio engine starts on this same gesture; give it a moment to come up
      setTimeout(() => bootSound('power-on'), 30);
    };
    window.addEventListener('keydown', on, { once: true });
    window.addEventListener('pointerdown', on, { once: true });
    return () => {
      window.removeEventListener('keydown', on);
      window.removeEventListener('pointerdown', on);
    };
  }, [powered, done]);

  // clock
  useEffect(() => {
    if (reduce) {
      setDone(true);
      return;
    }
    if (!powered) return;
    let raf = 0;
    const tick = () => {
      setT(performance.now() - start.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduce, powered]);

  const endAt = skipAt !== null ? skipAt + OFF_MS : BOOT_END + OFF_MS;
  useEffect(() => {
    if (!done && t >= endAt) setDone(true);
  }, [t, endAt, done]);

  // skip with any click or key — listeners live only while the screen is on
  useEffect(() => {
    if (done || !powered) return;
    const skip = () => setSkipAt((s) => s ?? Math.min(performance.now() - start.current, BOOT_END));
    window.addEventListener('keydown', skip);
    window.addEventListener('pointerdown', skip);
    return () => {
      window.removeEventListener('keydown', skip);
      window.removeEventListener('pointerdown', skip);
    };
  }, [done, powered]);

  // sounds follow the picture: BIOS beep after the memory test, a tick per task, a blip per OK, a zap on power-off
  useEffect(() => {
    if (!powered || done) return;
    const p = played.current;
    const offStart = skipAt ?? BOOT_END;
    if (t >= offStart) {
      if (!p.off) {
        p.off = true;
        bootSound('power-off');
      }
      return;
    }
    if (!p.beep && t >= ON_MS + MEM_MS) {
      p.beep = true;
      bootSound('beep');
    }
    const started = Math.max(0, Math.min(TASKS.length, Math.floor((t - TASKS_START) / TASK_MS) + 1));
    if (t >= TASKS_START && started > p.ticks) {
      p.ticks = started;
      bootSound('tick');
    }
    const oks = Math.max(0, Math.min(TASKS.length, Math.floor((t - TASKS_START - TASK_MS * 0.85) / TASK_MS) + 1));
    if (oks > p.oks) {
      p.oks = oks;
      bootSound('ok');
    }
  }, [t, powered, done, skipAt]);

  if (done) return null;
  if (!powered)
    return (
      <div className="boot phase-standby" aria-label="Press any key to power on">
        <div className="standby">
          <div className="standby-text blink">PRESS ANY KEY TO POWER ON</div>
          <div className="standby-led" title="standby" />
        </div>
      </div>
    );
  const offStart = skipAt ?? BOOT_END;
  const phase = t < ON_MS ? 'on' : t >= offStart ? 'off' : 'boot';
  const mem = Math.min(640, Math.floor(((t - ON_MS) / MEM_MS) * 640));
  const taskT = t - TASKS_START;
  const progress = Math.max(0, Math.min(1, (t - ON_MS) / (BOOT_END - ON_MS - 250)));

  return (
    <div className={`boot phase-${phase}`} aria-label="Loading HEAT INDEX">
      <div className="boot-screen">
        <div className="boot-log">
          <div className="boot-title">HEAT INDEX</div>
          <div className="boot-sub">UNDERGROUND ROBOT ARENA · BIOS v2.86 · (C) 2087 KESSLER CORP</div>
          <pre>
            {`CPU: SCRAPYARD-9 @ 4.77 GHZ ............ OK\n`}
            {`MEMORY TEST: ${String(Math.max(0, mem)).padStart(3, ' ')}K ..................... ${mem >= 640 ? 'OK' : '  '}\n\n`}
            {TASKS.map((task, i) => {
              const since = taskT - i * TASK_MS;
              if (since < 0) return null;
              const ok = since >= TASK_MS * 0.85;
              const spin = SPIN[Math.floor(since / 70) % SPIN.length];
              return (
                <span key={task} className={ok ? 'ok-line' : 'run-line'}>
                  {`${task.padEnd(32, '.')} [${ok ? ' OK ' : ` ${spin}  `}]\n`}
                </span>
              );
            })}
          </pre>
          <div className="boot-progress">
            <i style={{ width: `${progress * 100}%` }} />
          </div>
          <div className="boot-pct">LOADING {Math.round(progress * 100)}%</div>
          <div className="boot-hint">{progress >= 1 ? 'ENTERING THE ARENA…' : 'click or press any key to skip'}</div>
        </div>
      </div>
    </div>
  );
}
