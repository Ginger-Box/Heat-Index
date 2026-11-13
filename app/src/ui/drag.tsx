// Smooth card dragging (instead of the browser's built-in drag & drop).
// The card lifts, follows the cursor with slight inertia and tilts in the direction of movement.
// On release it first flies into the target spot, then the move is committed (so the screen redraw
// happens while the card is already in place — no hitch). If the drop is not allowed, the card
// flies back to where it came from.
// Drop targets are marked with the data-drop="..." attribute. Uses Pointer Events, so it works with mouse and touch.
// The ghost is moved directly through style (not React state) so dragging doesn't slow down rendering.

import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { sfx } from '../audio';

const START_PX = 6; // how far to drag before it counts as a drag rather than a click
const FLY_IN_MS = 130; // flight into the target spot
const FLY_BACK_MS = 200; // flight back home

interface Active {
  id: string;
  startX: number;
  startY: number;
  offX: number;
  offY: number;
  homeX: number; // where the card was taken from (viewport px)
  homeY: number;
  w: number;
  h: number;
  started: boolean;
}

/**
 * onDrop(id, target) is called after the card has flown into the target.
 * Return true if the drop is accepted (the card "lands"), false — it flies back and shakes «no»,
 * 'cancel' — it just flies back (e.g. dropped where it already was).
 * A target with data-drop-instant (a large area like the whole hangar) is accepted without a flight:
 * the card simply fades out there.
 */
export function useCardDrag(onDrop: (id: string, target: string | null) => boolean | 'cancel') {
  const [dragId, setDragId] = useState<string | null>(null);
  const [ghostNode, setGhostNode] = useState<ReactNode>(null);
  const [over, setOver] = useState<string | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const active = useRef<Active | null>(null);
  const flying = useRef<Active | null>(null);
  const ghost = useRef<HTMLDivElement | null>(null);
  const pos = useRef({ tx: 0, ty: 0, x: 0, y: 0, tilt: 0 });
  const raf = useRef(0);
  const overRef = useRef<string | null>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const renderRef = useRef<() => ReactNode>(() => null);

  const scale = () => Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;

  /** Put the ghost so the card's top-left corner is at (x, y) in viewport px. */
  const setTransform = (x: number, y: number, tilt: number, a: Active) => {
    if (!ghost.current) return;
    const s = scale();
    ghost.current.style.transform = `translate(${x / s}px, ${y / s}px) rotate(${tilt.toFixed(2)}deg)`;
    ghost.current.style.transformOrigin = `${a.offX / s}px ${a.offY / s}px`;
  };
  const follow = () => {
    const a = active.current;
    const p = pos.current;
    if (a) setTransform(p.x - a.offX, p.y - a.offY, p.tilt, a);
  };
  const setGhost = (el: HTMLDivElement | null) => {
    ghost.current = el;
    follow(); // position immediately so the card doesn't flash in the corner
  };

  // Ghost animation: inertia + tilt from horizontal speed
  const loop = () => {
    const p = pos.current;
    const px = p.x;
    p.x += (p.tx - p.x) * 0.38;
    p.y += (p.ty - p.y) * 0.38;
    const tiltTarget = Math.max(-14, Math.min(14, (p.x - px) * 0.9));
    p.tilt += (tiltTarget - p.tilt) * 0.25;
    follow();
    raf.current = requestAnimationFrame(loop);
  };

  useEffect(() => {
    const fly = (a: Active, x: number, y: number, ms: number, then: () => void) => {
      const g = ghost.current;
      if (!g) return then();
      g.classList.add('settling');
      g.style.transition = `transform ${ms}ms cubic-bezier(0.2, 0.8, 0.3, 1)`;
      setTransform(x, y, 0, a);
      setTimeout(then, ms);
    };
    const finish = () => {
      flying.current = null;
      setDragId(null);
      setGhostNode(null);
      // card tooltips don't pop up for half a second — so they don't appear under the cursor right after a drop
      document.body.classList.add('tip-cooldown');
      setTimeout(() => document.body.classList.remove('tip-cooldown'), 500);
    };
    /** Landing animation in place (without re-creating the card — otherwise the tooltip blinks again). */
    const landFx = (id: string) =>
      requestAnimationFrame(() => {
        const host = document.querySelector(`[data-drag-id="${CSS.escape(id)}"]`) as HTMLElement | null;
        const card = host?.querySelector('.card') as HTMLElement | null;
        if (!host || !card || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        card.animate(
          [
            { transform: 'scale(1)', filter: 'brightness(1.35)' },
            { transform: 'scale(0.97)', offset: 0.4 },
            { transform: 'none', filter: 'none' },
          ],
          { duration: 320, easing: 'ease-out' },
        );
        card.animate(
          [{ boxShadow: '0 0 0 2px #00f0ffcc' }, { boxShadow: '0 0 0 12px #00f0ff00' }],
          { duration: 420, easing: 'ease-out' },
        );
      });
    const goHome = (a: Active, deny: boolean) => {
      sfx('card-pick', { volume: 0.7 });
      fly(a, a.homeX, a.homeY, FLY_BACK_MS, () => {
        finish();
        if (deny) {
          setDenied(a.id);
          setTimeout(() => setDenied((d) => (d === a.id ? null : d)), 380);
        }
      });
    };

    const move = (e: PointerEvent) => {
      const a = active.current;
      if (!a) return;
      if (!a.started) {
        if (Math.hypot(e.clientX - a.startX, e.clientY - a.startY) < START_PX) return;
        a.started = true;
        pos.current = { tx: e.clientX, ty: e.clientY, x: e.clientX, y: e.clientY, tilt: 0 };
        setGhostNode(renderRef.current());
        setDragId(a.id);
        document.body.classList.add('is-dragging');
        sfx('card-pick');
        raf.current = requestAnimationFrame(loop);
      }
      pos.current.tx = e.clientX;
      pos.current.ty = e.clientY;
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-drop]');
      const target = el?.getAttribute('data-drop') ?? null;
      if (target !== overRef.current) {
        overRef.current = target;
        setOver(target);
        if (target) sfx('ui-hover');
      }
    };

    const up = () => {
      const a = active.current;
      active.current = null;
      if (!a || !a.started) return;
      flying.current = a;
      cancelAnimationFrame(raf.current);
      document.body.classList.remove('is-dragging');
      // the click after a drag must not fire as a regular click
      const block = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener('click', block, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', block, { capture: true }), 0);

      const target = overRef.current;
      overRef.current = null;
      setOver(null);
      const el = target ? document.querySelector(`[data-drop="${target}"]`) : null;
      if (!target || !el) return goHome(a, false);

      if (el.hasAttribute('data-drop-instant')) {
        const ok = onDropRef.current(a.id, target);
        if (ok !== true) return goHome(a, ok === false);
        sfx('card-drop', { volume: 0.7 });
        ghost.current?.classList.add('vanish');
        setTimeout(finish, 140);
        return;
      }

      // Fly into the target: onto the card already there, or into the center of an empty spot
      const occupant = el.querySelector('.card')?.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const x = occupant ? occupant.left : r.left + (r.width - a.w) / 2;
      const y = occupant ? occupant.top : r.top + Math.max(0, (r.height - a.h) / 2);
      fly(a, x, y, FLY_IN_MS, () => {
        const ok = onDropRef.current(a.id, target);
        if (ok !== true) return goHome(a, ok === false);
        finish();
        sfx('card-drop');
        landFx(a.id);
      });
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      cancelAnimationFrame(raf.current);
      document.body.classList.remove('is-dragging');
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Props for the wrapper around a card that can be dragged. render — what the lifted card looks like.
   * Cards drawn elsewhere (e.g. on a battle lane) can get the landing animation too: give their wrapper data-drag-id.
   */
  const handle = (id: string, render: () => ReactNode, enabled = true) => ({
    key: id,
    props: {
      'data-drag-id': id,
      className: [
        'drag-handle',
        enabled ? 'can-drag' : '',
        dragId === id ? 'drag-src' : '',
        denied === id ? 'deny' : '',
      ].join(' '),
      onPointerDown: (e: RPointerEvent<HTMLElement>) => {
        if (!enabled || e.button !== 0 || flying.current) return;
        const r = e.currentTarget.getBoundingClientRect();
        const card = e.currentTarget.querySelector('.card')?.getBoundingClientRect() ?? r;
        active.current = {
          id,
          startX: e.clientX,
          startY: e.clientY,
          offX: e.clientX - card.left,
          offY: e.clientY - card.top,
          homeX: card.left,
          homeY: card.top,
          w: card.width,
          h: card.height,
          started: false,
        };
        renderRef.current = render;
      },
    },
  });

  const ghostEl =
    ghostNode &&
    createPortal(
      <div className="drag-ghost" ref={setGhost}>
        {ghostNode}
      </div>,
      document.getElementById('root') ?? document.body,
    );

  return {
    handle,
    ghost: ghostEl,
    over,
    dragging: dragId,
  };
}
