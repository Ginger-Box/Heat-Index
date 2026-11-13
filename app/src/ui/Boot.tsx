// Loading screen like an old CRT TV + PC: the tube switches on softly → a "BIOS" boots the arena
// (beep, a quiet fax/modem handshake, ticks, OK blips) → "PRESS ANY BUTTON TO CONTINUE" → the picture collapses.
// It starts right after the player logs in — that click has already unlocked the sound (browsers only allow audio
// after a user gesture). A click during the boot skips to the end. When it is done, the app powers on like a TV.
// Everything on screen is derived from the elapsed time, so it is deterministic and easy to tune.

import { useEffect, useRef, useState } from 'react';
import { bootSound, faxSound } from '../audio';

const TASKS = [
  'INITIALIZING NEON TUBES',
  'DIALING MARKET UPLINK',
  'MOUNTING SCRAPYARD DRIVE',
  'LOADING ARENA PROTOCOLS',
  'SPAWNING 12 NPC TEAMS',
  'WAKING UP AI BROKERS (3)',
  'CALIBRATING OVERHEAT SENSORS',
];
const ON_MS = 380; // tube switch-on
const MEM_MS = 520; // memory test counter
const TASK_MS = 320; // per task
const TASKS_START = ON_MS + MEM_MS;
const BOOT_END = TASKS_START + TASKS.length * TASK_MS + 250;
const OFF_MS = 330; // tube switch-off
const SPIN = ['|', '/', '-', '\\'];

export function Boot({ onDone }: { onDone?: () => void }) {
  const [t, setT] = useState(0); // ms since power-on
  const [offAt, setOffAt] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const start = useRef(performance.now());
  const played = useRef({ on: false, beep: false, fax: false, ticks: 0, oks: 0, ready: false, off: false });
  const stopFax = useRef<() => void>(() => {});
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ready = t >= BOOT_END;

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

  useEffect(() => {
    if (!done && offAt !== null && t >= offAt + OFF_MS) setDone(true);
  }, [t, offAt, done]);

  useEffect(() => {
    if (done) onDone?.();
  }, [done]); // eslint-disable-line react-hooks/exhaustive-deps

  // any click or key: during the boot — skip to the game; on the prompt — continue
  useEffect(() => {
    if (done || offAt !== null) return;
    const go = () => {
      stopFax.current();
      setOffAt(performance.now() - start.current);
    };
    window.addEventListener('keydown', go);
    window.addEventListener('pointerdown', go);
    return () => {
      window.removeEventListener('keydown', go);
      window.removeEventListener('pointerdown', go);
    };
  }, [done, offAt]);

  // sounds follow the picture
  useEffect(() => {
    if (done) return;
    const p = played.current;
    if (offAt !== null) {
      if (!p.off) {
        p.off = true;
        // the press that unlocked the audio arrives a moment before the context is running
        setTimeout(() => bootSound('power-off'), 30);
      }
      return;
    }
    if (!p.on) {
      p.on = true;
      bootSound('power-on');
    }
    if (!p.beep && t >= ON_MS + MEM_MS) {
      p.beep = true;
      bootSound('beep');
    }
    // the modem dials in with the "market uplink" task
    if (!p.fax && t >= TASKS_START + TASK_MS) {
      p.fax = true;
      stopFax.current = faxSound();
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
    if (!p.ready && ready) {
      p.ready = true;
      bootSound('ready');
    }
  }, [t, done, offAt, ready]);

  if (done) return null;
  const phase = t < ON_MS ? 'on' : offAt !== null ? 'off' : 'boot';
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
          <div className="boot-pct">{ready ? 'SYSTEM READY' : `LOADING ${Math.round(progress * 100)}%`}</div>
          {ready ? (
            <div className="boot-continue">
              <span className="blink">▶ PRESS ANY BUTTON TO CONTINUE</span>
              <i className="boot-caret" />
            </div>
          ) : (
            <div className="boot-hint">click or press any key to skip</div>
          )}
        </div>
      </div>
    </div>
  );
}
