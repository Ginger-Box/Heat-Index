// Loading screen like an old CRT TV: the tube switches on → a "BIOS" boots the arena → the picture collapses.
// Any click or key skips it. Lives outside the game (rendered next to <App/>), disappears when done.
// Everything on screen is derived from the elapsed time, so it is deterministic and easy to tune.

import { useEffect, useRef, useState } from 'react';

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
  const [t, setT] = useState(0); // ms since start
  const [skipAt, setSkipAt] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const start = useRef(performance.now());
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // clock
  useEffect(() => {
    if (reduce) {
      setDone(true);
      return;
    }
    let raf = 0;
    const tick = () => {
      setT(performance.now() - start.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduce]);

  const endAt = skipAt !== null ? skipAt + OFF_MS : BOOT_END + OFF_MS;
  useEffect(() => {
    if (!done && t >= endAt) setDone(true);
  }, [t, endAt, done]);

  // skip with any click or key — listeners live only while the screen is on
  useEffect(() => {
    if (done) return;
    const skip = () => setSkipAt((s) => s ?? Math.min(performance.now() - start.current, BOOT_END));
    window.addEventListener('keydown', skip);
    window.addEventListener('pointerdown', skip);
    return () => {
      window.removeEventListener('keydown', skip);
      window.removeEventListener('pointerdown', skip);
    };
  }, [done]);

  if (done) return null;
  const offStart = skipAt ?? BOOT_END;
  const phase = t < ON_MS ? 'on' : t >= offStart ? 'off' : 'boot';
  const mem = Math.min(640, Math.floor(((t - ON_MS) / MEM_MS) * 640));
  const taskT = t - TASKS_START;
  const progress = Math.max(0, Math.min(1, (t - ON_MS) / (BOOT_END - ON_MS - 250)));

  return (
    <div className={`boot phase-${phase}`} aria-label="Loading NEON PIT">
      <div className="boot-screen">
        <div className="boot-log">
          <div className="boot-title">NEON PIT</div>
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
          <div className="boot-hint">{progress >= 1 ? 'ENTERING THE PIT…' : 'click or press any key to skip'}</div>
        </div>
      </div>
    </div>
  );
}
