import { useEffect, useRef, useState } from 'react';
import {
  DAYS_PER_SEASON,
  HOURS_PER_DAY,
  PLAYER_ID,
  dayInSeason,
  getManager,
  netWorth,
  playNpcMatch,
} from './engine/world';
import { Analytics } from './screens/Analytics';
import { Arena } from './screens/Arena';
import { Brokers } from './screens/Brokers';
import { Hangar } from './screens/Hangar';
import { Market } from './screens/Market';
import { Ratings } from './screens/Ratings';
import { actBackground, resetGame, startGame, useWorld } from './store';
import { onSoundChange, setSoundEnabled, setSoundVolume, sfx, soundEnabled, soundVolume } from './audio';
import { Cr, Glitch } from './ui/common';
import { FastForwardIcon, GearIcon, PauseIcon, PlayIcon, SpeakerIcon } from './ui/icons';
import { FastForward } from './ui/FastForward';
import { Ticker } from './ui/Ticker';

const TABS = [
  ['arena', 'Arena'],
  ['hangar', 'Hangar'],
  ['market', 'Market'],
  ['brokers', 'Brokers'],
  ['analytics', 'Analytics'],
  ['ratings', 'Ratings'],
] as const;
type Tab = (typeof TABS)[number][0];

const LIVE_MS = 2500; // в живом режиме NPC играют матч каждые 2,5 секунды

export default function App() {
  const w = useWorld();
  const [tab, setTab] = useState<Tab>('arena');
  const [ff, setFf] = useState(false);
  const [live, setLive] = useState(true);

  useEffect(() => {
    if (!w || !live || ff) return;
    const t = setInterval(() => actBackground((w) => playNpcMatch(w)), LIVE_MS);
    return () => clearInterval(t);
  }, [!!w, live, ff]);

  if (!w) return <Login />;
  const me = getManager(w, PLAYER_ID);
  const hourOfDay = w.hour % HOURS_PER_DAY;

  return (
    <div className="app">
      <div className="panel topbar">
        <div className="logo" data-text="HEAT INDEX">
          HEAT INDEX
        </div>
        <div className="nav">
          {TABS.map(([id, label]) => (
            <button key={id} data-sfx="tab" className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <div className="stat">
          <b>
            <Cr v={me.credits} volume={1} />
          </b>
          <span>credits</span>
        </div>
        <div className="stat">
          <b>
            <Glitch text={netWorth(w, me)} />
          </b>
          <span>net worth</span>
        </div>
        <div className="stat">
          <b>
            <Glitch text={me.elo} />
          </b>
          <span>ELO</span>
        </div>
        <div className="stat">
          <b>
            <Glitch
              text={`S${w.season} · d${dayInSeason(w)}/${DAYS_PER_SEASON} · ${String(8 + hourOfDay).padStart(2, '0')}:00`}
            />
          </b>
          <span>season · day · time</span>
        </div>
        {!live && (
          <span className="tag paused-tag" title="The world is paused — open settings to resume">
            PAUSED
          </span>
        )}
        <SettingsMenu
          live={live}
          setLive={setLive}
          onFastForward={() => {
            sfx('fast-forward');
            setFf(true);
          }}
        />
      </div>

      <Ticker w={w} />

      {/* key={tab}: при смене вкладки блок пересоздаётся и проигрывает «включение кинескопа» */}
      <div className="content tab-crt" key={tab}>
        {tab === 'arena' && <Arena w={w} />}
        {tab === 'hangar' && <Hangar w={w} />}
        {tab === 'market' && <Market w={w} />}
        {tab === 'brokers' && <Brokers w={w} />}
        {tab === 'analytics' && <Analytics w={w} />}
        {tab === 'ratings' && <Ratings w={w} />}
      </div>
      {ff && <FastForward onClose={() => setFf(false)} />}
    </div>
  );
}

/** Gear in the top-right corner: live world, volume, fast-forward and starting over. */
function SettingsMenu({
  live,
  setLive,
  onFastForward,
}: {
  live: boolean;
  setLive: (v: boolean) => void;
  onFastForward: () => void;
}) {
  const [sureReset, setSureReset] = useState(false);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (box.current && !(e.target instanceof Node && box.current.contains(e.target))) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="settings" ref={box}>
      <button
        className={`gear-btn ${open ? 'on' : ''}`}
        onClick={() => setOpen(!open)}
        title="Settings"
        aria-label="Settings"
        aria-expanded={open}
      >
        <GearIcon size={18} />
      </button>
      {open && (
        <div className="settings-pop">
          <div className="set-row">
            <div>
              <b>Live world</b>
              <div className="muted">NPCs fight and trade in real time.</div>
            </div>
            <button onClick={() => setLive(!live)} className={live ? '' : 'primary'}>
              {live ? (
                <>
                  <PauseIcon /> Pause
                </>
              ) : (
                <>
                  <PlayIcon /> Resume
                </>
              )}
            </button>
          </div>
          <div className="set-row">
            <div>
              <b>Sound</b>
              <div className="muted">Effects and city ambience.</div>
            </div>
            <VolumeControl />
          </div>
          <div className="set-row">
            <div>
              <b>Fast-forward a week</b>
              <div className="muted">Watch 7 days of the economy in ~35 s.</div>
            </div>
            <button
              className="primary"
              data-sfx="none"
              onClick={() => {
                setOpen(false);
                onFastForward();
              }}
            >
              <FastForwardIcon /> Play
            </button>
          </div>
          <div className="set-row">
            <div>
              <b>Start over</b>
              <div className="muted">Deletes all progress.</div>
            </div>
            {/* in-app confirmation: window.confirm() is blocked in some embedded browsers, so Reset did nothing */}
            <button
              className="danger"
              onClick={() => {
                if (!sureReset) {
                  setSureReset(true);
                  setTimeout(() => setSureReset(false), 4000);
                  return;
                }
                setSureReset(false);
                resetGame();
              }}
            >
              {sureReset ? 'Sure? Click again' : 'Reset'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function VolumeControl() {
  const [, force] = useState(0);
  useEffect(() => {
    const off = onSoundChange(() => force((x) => x + 1));
    return () => {
      off();
    };
  }, []);
  const on = soundEnabled();
  const vol = soundVolume();
  const muted = !on || vol === 0;
  const level = muted ? 0 : vol < 0.34 ? 1 : vol < 0.67 ? 2 : 3;
  const shown = Math.round((on ? vol : 0) * 100);
  return (
    <div className="sound-ctl">
      <button
        className="small icon-btn"
        onClick={() => {
          if (vol === 0) setSoundVolume(0.5);
          setSoundEnabled(muted);
        }}
        title={muted ? 'Turn sound on' : 'Mute'}
        aria-label={muted ? 'Turn sound on' : 'Mute'}
      >
        <SpeakerIcon level={level} size={20} />
      </button>
      <input
        type="range"
        min={0}
        max={100}
        value={shown}
        aria-label="Volume"
        style={{ ['--fill' as string]: `${shown}%` }}
        onChange={(e) => {
          const v = Number(e.target.value) / 100;
          setSoundVolume(v);
          if (!on && v > 0) setSoundEnabled(true);
        }}
        onPointerUp={() => sfx('ui-click')}
      />
      <span className="vol-num">{shown}</span>
    </div>
  );
}

function Login() {
  const [name, setName] = useState('');
  return (
    <div className="panel login">
      <div className="logo" data-text="HEAT INDEX" style={{ fontSize: 40, marginBottom: 8 }}>
        HEAT INDEX
      </div>
      <p className="muted">
        An underground robot arena. Build a team and fight for the title — or play the market: buy robots while they are
        cheap and invest in AI brokers.
      </p>
      <form
        className="grid"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) startGame(name.trim());
        }}
      >
        <input placeholder="What's your name?" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <button className="primary" disabled={!name.trim()}>
          Enter the arena
        </button>
      </form>
    </div>
  );
}
