// Pixel icons: drawn on a grid ('#' = pixel), colored with the current text color.
// No emoji, so they look the same everywhere and match the pixel style.

function PixelIcon({ rows, size = 20, title }: { rows: string[]; size?: number; title?: string }) {
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const px: [number, number][] = [];
  rows.forEach((r, y) => [...r].forEach((c, x) => c === '#' && px.push([x, y])));
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width={size}
      height={(size * h) / w}
      shapeRendering="crispEdges"
      fill="currentColor"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      className="px-icon"
    >
      {title && <title>{title}</title>}
      {px.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} />
      ))}
    </svg>
  );
}

// Speaker: body + 0–3 sound waves, or a cross when muted
const SPEAKER = [
  '....#........',
  '...##........',
  '..###........',
  '#####........',
  '#####........',
  '#####........',
  '#####........',
  '#####........',
  '..###........',
  '...##........',
  '....#........',
];
const WAVES: [number, number][][] = [
  [
    [7, 4],
    [7, 5],
    [7, 6],
  ],
  [
    [8, 2],
    [9, 3],
    [9, 4],
    [9, 5],
    [9, 6],
    [9, 7],
    [8, 8],
  ],
  [
    [10, 0],
    [11, 1],
    [11, 2],
    [12, 3],
    [12, 4],
    [12, 5],
    [12, 6],
    [12, 7],
    [11, 8],
    [11, 9],
    [10, 10],
  ],
];
const CROSS: [number, number][] = [
  [8, 3],
  [9, 4],
  [10, 5],
  [11, 6],
  [12, 7],
  [12, 3],
  [11, 4],
  [9, 6],
  [8, 7],
];

/** level: 0 — muted, 1..3 — number of waves. */
export function SpeakerIcon({ level, size = 22 }: { level: 0 | 1 | 2 | 3; size?: number }) {
  const grid = SPEAKER.map((r) => [...r]);
  const extra = level === 0 ? CROSS : WAVES.slice(0, level).flat();
  for (const [x, y] of extra) grid[y][x] = '#';
  return <PixelIcon rows={grid.map((r) => r.join(''))} size={size} title={level === 0 ? 'Muted' : 'Sound on'} />;
}

const GEAR = [
  '.....###.....',
  '..#..###..#..',
  '.###########.',
  '..#########..',
  '..###...###..',
  '####.....####',
  '####.....####',
  '####.....####',
  '..###...###..',
  '..#########..',
  '.###########.',
  '..#..###..#..',
  '.....###.....',
];

export function GearIcon({ size = 22 }: { size?: number }) {
  return <PixelIcon rows={GEAR} size={size} />;
}

const PAUSE = ['##.##', '##.##', '##.##', '##.##', '##.##', '##.##', '##.##'];
const PLAY = ['#....', '##...', '###..', '####.', '###..', '##...', '#....'];
const FFWD = ['#...#....', '##..##...', '###.###..', '########.', '###.###..', '##..##...', '#...#....'];

export const PauseIcon = ({ size = 14 }: { size?: number }) => <PixelIcon rows={PAUSE} size={size} />;
export const PlayIcon = ({ size = 14 }: { size?: number }) => <PixelIcon rows={PLAY} size={size} />;
export const FastForwardIcon = ({ size = 18 }: { size?: number }) => <PixelIcon rows={FFWD} size={size} />;

// ---------- stat icons: energy, attack, HP ----------
const BOLT = ['...###', '..###.', '.###..', '######', '..###.', '.###..', '.##...', '##....', '#.....'];
const SWORD = [
  '.......##',
  '......###',
  '.....###.',
  '....###..',
  '.#.###...',
  '..###....',
  '..##.....',
  '.#..#....',
  '#........',
];
const HEART = ['.##...##.', '####.####', '#########', '#########', '.#######.', '..#####..', '...###...', '....#....'];

/** Energy cost (yellow lightning). */
export const EnergyIcon = ({ size = 11 }: { size?: number }) => (
  <span className="stat-ico energy">
    <PixelIcon rows={BOLT} size={size * 0.75} />
  </span>
);
/** Attack (orange sword). */
export const AttackIcon = ({ size = 12 }: { size?: number }) => (
  <span className="stat-ico attack">
    <PixelIcon rows={SWORD} size={size} />
  </span>
);
/** HP (green heart). */
export const HpIcon = ({ size = 12 }: { size?: number }) => (
  <span className="stat-ico hp">
    <PixelIcon rows={HEART} size={size} />
  </span>
);
