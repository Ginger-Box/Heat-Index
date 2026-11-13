// Хранилище мира на клиенте: один объект World + счётчик версий для перерисовки React.
// Позже этот слой заменяется на сервер, который пишет сделки и бои в NEAR.
import { useEffect, useReducer } from 'react';
import { sfx } from './audio';
import { createWorld, type World } from './engine/world';

const KEY = 'neon-pit-world-v3'; // v3: English names — older saves are incompatible
const NAME_KEY = 'neon-pit-player';

let world: World | null = null;
let version = 0;
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function load(): World | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? migrate(JSON.parse(raw) as World) : null;
  } catch {
    return null;
  }
}

/** Подтянуть в старое сохранение настройки, которые поменялись после балансировки. */
function migrate(w: World): World {
  for (const b of w.brokers) {
    if (b.id === 'kessler') b.style.targetStock = 3;
    if (b.id === 'soroka') b.style.spread = 0.08;
  }
  return w;
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      if (world) localStorage.setItem(KEY, JSON.stringify(world));
    } catch {
      /* хранилище недоступно — играем без сохранения */
    }
  }, 500);
}

export function getPlayerName(): string | null {
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}

export function startGame(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* ignore */
  }
  world = load() ?? createWorld(Date.now() % 2 ** 31, name);
  notify();
}

export function resetGame() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(NAME_KEY);
  } catch {
    /* ignore */
  }
  world = null;
  notify();
}

export function getWorld(): World | null {
  if (!world && getPlayerName()) world = load();
  return world;
}

/** Изменить мир и перерисовать интерфейс. Функция возвращает текст ошибки или null. */
export function act(fn: (w: World) => string | null | void): string | null {
  const w = getWorld();
  if (!w) return 'World is not loaded';
  const res = fn(w) ?? null;
  if (res) sfx('ui-error');
  notify();
  return res;
}

export function notify() {
  version++;
  save();
  for (const l of listeners) l();
}

export function useWorld(): World | null {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    listeners.add(force);
    return () => {
      listeners.delete(force);
    };
  }, []);
  return getWorld();
}

export const worldVersion = () => version;
