// The hint arrow of the tutorial and the tab tour, in the HUD style of the game: a pixel-dashed neon line with a dark
// outline, a bright "data packet" running along it, a chunky chevron head, and blinking corner brackets around the
// target (like the cursor's). Drawn on <body> in viewport pixels.

import { createPortal } from 'react-dom';

export function NeonPointer({
  x0,
  y0,
  x1,
  y1,
  target,
}: {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** rect of the thing pointed at — gets corner brackets */
  target?: { left: number; top: number; right: number; bottom: number };
}) {
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const deg = (ang * 180) / Math.PI;
  const HEAD = 20;
  // the line stops at the chevron's notch
  const lx = x1 - Math.cos(ang) * (HEAD - 6);
  const ly = y1 - Math.sin(ang) * (HEAD - 6);
  const d = `M ${x0.toFixed(1)} ${y0.toFixed(1)} L ${lx.toFixed(1)} ${ly.toFixed(1)}`;
  const P = 7; // bracket padding
  const L = 12; // bracket arm
  const br = target && [
    `M ${target.left - P} ${target.top - P + L} V ${target.top - P} H ${target.left - P + L}`,
    `M ${target.right + P - L} ${target.top - P} H ${target.right + P} V ${target.top - P + L}`,
    `M ${target.left - P} ${target.bottom + P - L} V ${target.bottom + P} H ${target.left - P + L}`,
    `M ${target.right + P - L} ${target.bottom + P} H ${target.right + P} V ${target.bottom + P - L}`,
  ];
  return createPortal(
    <svg className="neon-pointer" width={innerWidth} height={innerHeight} aria-hidden>
      <path className="np-shadow" d={d} />
      <path className="np-line" d={d} />
      <rect className="np-packet" x={-3} y={-3} width={6} height={6}>
        <animateMotion dur="1.1s" repeatCount="indefinite" path={d} />
      </rect>
      <g transform={`translate(${x1.toFixed(1)} ${y1.toFixed(1)}) rotate(${deg.toFixed(1)})`}>
        <polygon className="np-head" points={`0,0 ${-HEAD},${-12} ${-HEAD + 7},0 ${-HEAD},12`} />
        <polygon className="np-head-core" points={`-4,0 ${-HEAD + 4},${-7} ${-HEAD + 9},0 ${-HEAD + 4},7`} />
      </g>
      {br?.map((p, i) => <path key={i} className="np-bracket" d={p} />)}
    </svg>,
    document.body,
  );
}
