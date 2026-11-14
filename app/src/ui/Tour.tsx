// First-launch tour of the tabs (after the training battle): each tab button is spotlit, a dashed arrow runs
// from the caption box to it, and the box says what the tab is for. Next / Skip. Drawn on <body> in viewport pixels
// (the caption box carries the UI zoom itself).

import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { sfx } from '../audio';
import { NeonPointer } from './Pointer';

export const TOUR: { tab: string; title: string; text: string }[] = [
  { tab: 'arena', title: 'ARENA', text: 'The Pit League (PvE): beat the bot teams of your division to move up. Every battle pays credits and wears your robots out.' },
  { tab: 'online', title: 'ONLINE', text: "Ranked battles against other players' decks, played by the AI under their name. Only these count for ELO and the Ratings." },
  {
    tab: 'hangar',
    title: 'HANGAR',
    text: 'All your robots live here. Build up to 5 decks of 10–15 robots, and repair the worn ones for credits.',
  },
  {
    tab: 'market',
    title: 'MARKET',
    text: 'Buy and sell robots. A price follows how well the robot does in battles — brokers notice late, so buy before they do.',
  },
  {
    tab: 'brokers',
    title: 'BROKERS',
    text: 'Three AI traders run the market. Invest credits in a broker and get a share of its daily profit.',
  },
  { tab: 'analytics', title: 'ANALYTICS', text: 'Price and relevance history of every robot and every class — spot the trends.' },
  { tab: 'ratings', title: 'RATINGS', text: 'The online ELO ladder (players and bots) and the richest managers. A season lasts 7 days.' },
];

export function Tour({ onTab, onDone }: { onTab: (tab: string) => void; onDone: () => void }) {
  const [i, setI] = useState(0);
  const [geo, setGeo] = useState<{ tab: DOMRect; nav: DOMRect } | null>(null);
  const step = TOUR[i];

  useEffect(() => onTab(step.tab), [i]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    // the tab buttons don't move when the content switches, so they can be measured right away
    const measure = () => {
      const tab = document.querySelector(`[data-tab="${step.tab}"]`)?.getBoundingClientRect();
      const nav = document.querySelector('.nav')?.getBoundingClientRect();
      if (tab && nav) setGeo({ tab, nav });
    };
    measure();
    addEventListener('resize', measure);
    return () => removeEventListener('resize', measure);
  }, [i, step.tab]);

  const next = () => {
    if (i + 1 >= TOUR.length) {
      sfx('ui-close');
      onDone();
    } else {
      sfx('ui-open', { volume: 0.7 });
      setI(i + 1);
    }
  };
  if (!geo) return null;
  const s = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
  const { tab, nav } = geo;
  const pad = 6;
  // ONE window that stays put under the tab bar; only its text and the arrow change from step to step
  const boxW = 440 * s;
  const bx = Math.max(16, Math.min(innerWidth - boxW - 16, nav.left + nav.width / 2 - boxW / 2));
  const by = nav.bottom + 150 * s;
  // the arrow leaves the box's top edge at the point closest to the tab
  const ax0 = Math.max(bx + 24, Math.min(bx + boxW - 24, tab.left + tab.width / 2));
  return createPortal(
    <>
      <div
        className="tour-dim"
        style={{ left: tab.left - pad, top: tab.top - pad, width: tab.width + pad * 2, height: tab.height + pad * 2 }}
      />
      <NeonPointer x0={ax0} y0={by - 6} x1={tab.left + tab.width / 2} y1={tab.bottom + 20} target={tab} />
      <div className="tour-box" style={{ left: bx / s, top: by / s }}>
        <h3>
          <span key={i} className="tour-swap">
            {step.title}
          </span>{' '}
          <span className="muted" style={{ fontSize: 10 }}>
            {i + 1}/{TOUR.length}
          </span>
        </h3>
        <p key={i} className="tour-swap">
          {step.text}
        </p>
        <div className="row">
          <button className="small" onClick={onDone}>
            Skip
          </button>
          <button className="primary" onClick={next}>
            Got it ▶
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
