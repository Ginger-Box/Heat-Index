// First-launch tour of the tabs (after the training battle): each tab button is spotlit, a dashed arrow runs
// from the caption box to it, and the box says what the tab is for. Next / Skip. Drawn on <body> in viewport pixels
// (the caption box carries the UI zoom itself).

import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { sfx } from '../audio';

export const TOUR: { tab: string; title: string; text: string }[] = [
  { tab: 'arena', title: 'ARENA', text: 'Pick an opponent and one of your decks, fight for credits and ELO. Every battle wears your robots out.' },
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
  { tab: 'ratings', title: 'RATINGS', text: 'The ELO ladder and the richest managers. A season lasts 7 game days.' },
];

export function Tour({ onTab, onDone }: { onTab: (tab: string) => void; onDone: () => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = TOUR[i];

  useEffect(() => onTab(step.tab), [i]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const measure = () => setRect(document.querySelector(`[data-tab="${step.tab}"]`)?.getBoundingClientRect() ?? null);
    measure();
    const id = setTimeout(measure, 350); // after the tab switch animation
    addEventListener('resize', measure);
    return () => {
      clearTimeout(id);
      removeEventListener('resize', measure);
    };
  }, [i, step.tab]);

  const next = () => {
    if (i + 1 >= TOUR.length) {
      sfx('ui-close');
      onDone();
    } else {
      sfx('ui-open');
      setI(i + 1);
    }
  };
  if (!rect) return null;
  const s = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
  const pad = 6;
  // the caption box sits below the tab, a bit to the right, so the arrow has room to curve up to the button
  const bx = Math.min(innerWidth - 440 * s - 16, Math.max(16, rect.left + 40));
  const by = rect.bottom + 120;
  const ax0 = bx + 60;
  const ay0 = by;
  const ax1 = rect.left + rect.width / 2;
  const ay1 = rect.bottom + pad + 6;
  return createPortal(
    <>
      <div
        className="tour-dim"
        style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }}
      />
      <svg className="tour-arrow" style={{ left: 0, top: 0, width: innerWidth, height: innerHeight }}>
        <path d={`M ${ax0} ${ay0} Q ${ax0} ${(ay0 + ay1) / 2} ${ax1} ${ay1 + 14}`} />
        <polygon
          points={[
            [ax1, ay1],
            [ax1 - 9, ay1 + 16],
            [ax1 + 9, ay1 + 16],
          ]
            .map((p) => p.join(','))
            .join(' ')}
        />
      </svg>
      <div className="tour-box" style={{ left: bx / s, top: by / s }} key={i}>
        <h3>
          {step.title} <span className="muted" style={{ fontSize: 10 }}>{i + 1}/{TOUR.length}</span>
        </h3>
        <p>{step.text}</p>
        <div className="row">
          <button className="small" onClick={onDone}>
            Skip
          </button>
          <button className="primary" onClick={next}>
            {i + 1 >= TOUR.length ? 'Start playing' : 'Next ▶'}
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
