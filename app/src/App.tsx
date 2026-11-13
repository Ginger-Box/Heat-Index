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
import { actBackground, getWorld, resetGame, startGame, useWorld } from './store';
import { chainSession, emailLoginPending, resumeEmailLogin, signOutChain } from './near/chain';
import { Boot } from './ui/Boot';
import { tvSound } from './audio';
import type { World } from './engine/world';
import { linkRobots } from './near/bridge';
import { onSoundChange, setSoundEnabled, setSoundVolume, sfx, soundEnabled, soundVolume } from './audio';
import { Cr, Glitch } from './ui/common';
import { FastForwardIcon, GearIcon, PauseIcon, PlayIcon, SpeakerIcon } from './ui/icons';
import { FastForward } from './ui/FastForward';
import { Tour } from './ui/Tour';
import { NearCell, NearLogin } from './ui/NearPanel';

const TUTORIAL_KEY = 'heat-index-tutorial';
type TutorialStage = 'battle' | 'tour' | 'done';
function readTutorial(): TutorialStage {
  try {
    const v = localStorage.getItem(TUTORIAL_KEY);
    return v === 'tour' || v === 'done' ? v : 'battle';
  } catch {
    return 'done';
  }
}

const TABS = [
  ['arena', 'Arena'],
  ['hangar', 'Hangar'],
  ['market', 'Market'],
  ['brokers', 'Brokers'],
  ['analytics', 'Analytics'],
  ['ratings', 'Ratings'],
] as const;
type Tab = (typeof TABS)[number][0];

const LIVE_MS = 2500; // in the live world NPCs play a match every 2.5 seconds

export default function App() {
  const w = useWorld();
  const [tab, setTab] = useState<Tab>('arena');
  // first launch: a training battle, then a tour of the tabs (remembered in localStorage)
  const [tutorial, setTutorial] = useState<TutorialStage>(readTutorial);
  const advanceTutorial = (next: TutorialStage) => {
    setTutorial(next);
    try {
      localStorage.setItem(TUTORIAL_KEY, next);
    } catch {
      /* no storage — the tutorial just won't be remembered */
    }
  };
  const [ff, setFf] = useState(false);
  const [live, setLive] = useState(true);
  // The site starts on the login screen (whose click also unlocks the sound) → the boot screen → the game,
  // which then powers on like an old TV. Returning players get a "welcome back" screen instead of the login.
  const [stage, setStage] = useState<'login' | 'boot' | 'game'>('login');
  const [powerOn, setPowerOn] = useState(false);
  const enter = () => setStage('boot');
  // coming back from the NEAR Auth login page (email login by redirect): finish creating the account
  const [resume, setResume] = useState<{ busy: boolean; error: string | null }>(() => ({
    busy: emailLoginPending(),
    error: null,
  }));
  useEffect(() => {
    if (!resume.busy) return;
    resumeEmailLogin()
      .then(async (r) => {
        if (r && !getWorld()) startGame(r.name);
        if (r) await linkRobots();
        setResume({ busy: false, error: null });
      })
      .catch((e) => {
        console.error('[NEAR] email login', e);
        setResume({ busy: false, error: e instanceof Error ? e.message : String(e) });
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!w || !live || ff || stage !== 'game') return;
    const t = setInterval(() => actBackground((w) => playNpcMatch(w)), LIVE_MS);
    return () => clearInterval(t);
  }, [!!w, live, ff, stage]);

  if (resume.busy)
    return (
      <div className="panel login">
        <div className="logo" data-text="HEAT INDEX" style={{ fontSize: 40, marginBottom: 8 }}>
          HEAT INDEX
        </div>
        <p className="near-resume">Creating your NEAR account…</p>
      </div>
    );
  if (!w)
    return (
      <Login
        error={resume.error}
        onEnter={(name) => {
          startGame(name);
          enter();
        }}
      />
    );
  if (stage === 'login') return <Welcome w={w} onEnter={enter} />;
  if (stage === 'boot')
    return (
      <Boot
        onDone={() => {
          // the boot screen has collapsed into a dot — now the arena switches on
          setStage('game');
          setPowerOn(true);
          tvSound('on');
          setTimeout(() => setPowerOn(false), 1000);
        }}
      />
    );
  const me = getManager(w, PLAYER_ID);
  const hourOfDay = w.hour % HOURS_PER_DAY;

  return (
    <>
      {/* outside .app: the scaling power-on animation must not stretch this layer */}
      {powerOn && <div className="tv-on-fx" aria-hidden />}
    <div className={`app ${powerOn ? 'tv-power-on' : ''}`}>
      <div className="panel topbar">
        <div className="logo" data-text="HEAT INDEX">
          HEAT INDEX
        </div>
        <div className="nav">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              data-sfx="tab"
              data-tab={id}
              className={tab === id ? 'active' : ''}
              disabled={tutorial === 'battle'}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {/* HUD: four equal cells, label on top, a big value below */}
        <div className="hud">
          <NearCell />
          <div className="hud-cell credits" title="Credits you can spend">
            <span>CREDITS</span>
            <b>
              <Cr v={me.credits} volume={1} />
            </b>
          </div>
          <div className="hud-cell worth" title="Credits + what your robots and broker stakes are worth">
            <span>NET WORTH</span>
            <b>
              <Glitch text={`${netWorth(w, me)} CR`} />
            </b>
          </div>
          <div className="hud-cell elo" title="Your Arena rating">
            <span>ELO</span>
            <b>
              <Glitch text={me.elo} />
            </b>
          </div>
          <div className="hud-cell time" title="Season · day of the season · time">
            <span>SEASON {w.season}</span>
            <b>
              <Glitch text={`DAY ${dayInSeason(w)}/${DAYS_PER_SEASON} · ${String(8 + hourOfDay).padStart(2, '0')}:00`} />
            </b>
          </div>
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

      {/* decorative neon tube under the header (no information on purpose) */}
      <div className="neonbar" aria-hidden />

      {tutorial === 'tour' && <Tour onTab={(t) => setTab(t as Tab)} onDone={() => advanceTutorial('done')} />}

      {/* key={tab}: switching tabs re-creates the block, which plays the "CRT power-on" */}
      <div className="content tab-crt" key={tab}>
        {tutorial === 'battle' ? (
          <Arena w={w} tutorial={{ onDone: () => advanceTutorial('tour') }} key="training" />
        ) : (
          tab === 'arena' && <Arena w={w} />
        )}
        {tutorial !== 'battle' && tab === 'hangar' && <Hangar w={w} />}
        {tab === 'market' && <Market w={w} />}
        {tab === 'brokers' && <Brokers w={w} />}
        {tab === 'analytics' && <Analytics w={w} />}
        {tab === 'ratings' && <Ratings w={w} />}
      </div>
      {ff && <FastForward onClose={() => setFf(false)} />}
    </div>
    </>
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

/** First screen: log in (email first), connect a wallet, or try it as a guest. Any of these clicks unlocks the sound. */
function Login({ error, onEnter }: { error?: string | null; onEnter: (name: string) => void }) {
  const [name, setName] = useState('');
  const nm = name.trim();
  return (
    <div className="panel login">
      <div className="logo" data-text="HEAT INDEX" style={{ fontSize: 40, marginBottom: 8 }}>
        HEAT INDEX
      </div>
      <p className="muted">
        An underground robot arena. Build a team and fight for the title — or play the market: buy robots while they are
        cheap and invest in AI brokers.
      </p>
      <div className="grid">
        <input placeholder="Your name in the arena" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        {/* on NEAR: your robots and credits are tokens you own, every trade and battle is a transaction */}
        <NearLogin name={nm || 'pilot'} onDone={() => onEnter(nm || 'Pilot')} />
        {error && <div className="error">{error}</div>}
        <button type="button" className="login-offline" data-sfx="none" onClick={() => onEnter(nm || 'Guest')}>
          Play as a guest — just to try it, nothing is saved on-chain
        </button>
      </div>
    </div>
  );
}

/** Returning player: one click to continue (it also unlocks the sound), or start over. */
function Welcome({ w, onEnter }: { w: World; onEnter: () => void }) {
  const me = getManager(w, PLAYER_ID);
  const session = chainSession();
  const [sure, setSure] = useState(false);
  return (
    <div className="panel login">
      <div className="logo" data-text="HEAT INDEX" style={{ fontSize: 40, marginBottom: 8 }}>
        HEAT INDEX
      </div>
      <p className="welcome-name">
        Welcome back, <b>{me.name}</b>
      </p>
      <p className="muted" style={{ marginTop: 0 }}>
        {session ? (
          <>
            On NEAR as <b className="near-acc">{session.accountId}</b>
          </>
        ) : (
          'Playing as a guest (off-chain)'
        )}
      </p>
      <div className="grid">
        <button className="primary welcome-go" autoFocus onClick={onEnter}>
          ▶ Continue
        </button>
        <button
          type="button"
          className="login-offline"
          data-sfx="none"
          onClick={() => {
            if (!sure) return setSure(true);
            signOutChain();
            resetGame();
          }}
        >
          {sure ? 'Sure? This deletes your local progress — click again' : 'Log out / start over'}
        </button>
      </div>
    </div>
  );
}
