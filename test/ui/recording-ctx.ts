import type { Ctx2D } from '../../src/ui/renderer';

export type Call = [string, ...unknown[]];

const METHODS = new Set([
  'save',
  'restore',
  'beginPath',
  'closePath',
  'moveTo',
  'lineTo',
  'arc',
  'arcTo',
  'fill',
  'stroke',
  'fillRect',
  'strokeRect',
  'fillText',
  'strokeText',
  'setLineDash',
  'clearRect',
  'measureText',
  'createLinearGradient',
  'createRadialGradient',
  'createPattern',
  'drawImage',
  'roundRect',
  'quadraticCurveTo',
  'bezierCurveTo',
  'rect',
  'ellipse',
  'translate',
  'rotate',
  'scale',
  'clip',
]);

/** A fake 2D context that records every method call and every property assignment as a call list. */
export function recordingCtx(): { ctx: Ctx2D; calls: Call[] } {
  const calls: Call[] = [];
  const props = new Map<string, unknown>();
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_t, p) {
      if (typeof p !== 'string') return undefined;
      if (METHODS.has(p)) {
        return (...args: unknown[]) => {
          calls.push([p, ...args]);
        };
      }
      return props.get(p);
    },
    set(_t, p, v) {
      if (typeof p !== 'string') return false;
      props.set(p, v);
      calls.push(['set', p, v]);
      return true;
    },
  });
  return { ctx: ctx as unknown as Ctx2D, calls };
}

export const isGrey = (c: unknown): boolean => {
  if (typeof c !== 'string') return false;
  let m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
  if (m) return m[1].toLowerCase() === m[2].toLowerCase() && m[2].toLowerCase() === m[3].toLowerCase();
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c);
  if (m) return m[1].toLowerCase() === m[2].toLowerCase() && m[2].toLowerCase() === m[3].toLowerCase();
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(c);
  if (m) return m[1] === m[2] && m[2] === m[3];
  return false;
};

export const colorAssignments = (calls: Call[]): unknown[] =>
  calls.filter((c) => c[0] === 'set' && (c[1] === 'fillStyle' || c[1] === 'strokeStyle')).map((c) => c[2]);

export interface Text {
  text: string;
  x: number;
  y: number;
}

export const textCalls = (calls: Call[]): Text[] =>
  calls
    .filter((c) => c[0] === 'fillText' || c[0] === 'strokeText')
    .map((c) => ({ text: String(c[1]), x: c[2] as number, y: c[3] as number }));

export interface Shape {
  op: 'fill' | 'stroke';
  style: unknown;
  /** Points of the current path: moveTo/lineTo give [x, y], arc gives [centerX, centerY]. */
  points: [number, number][];
  /** Radii of the arcs of the path. */
  radii: number[];
}

/** Replays the calls and returns one entry per fill() / stroke() / fillRect() with the style and path it used. */
export function shapes(calls: Call[]): Shape[] {
  const out: Shape[] = [];
  let fillStyle: unknown;
  let strokeStyle: unknown;
  let points: [number, number][] = [];
  let radii: number[] = [];
  for (const c of calls) {
    switch (c[0]) {
      case 'set':
        if (c[1] === 'fillStyle') fillStyle = c[2];
        if (c[1] === 'strokeStyle') strokeStyle = c[2];
        break;
      case 'beginPath':
        points = [];
        radii = [];
        break;
      case 'moveTo':
      case 'lineTo':
        points.push([c[1] as number, c[2] as number]);
        break;
      case 'arc':
        points.push([c[1] as number, c[2] as number]);
        radii.push(c[3] as number);
        break;
      case 'fill':
        out.push({ op: 'fill', style: fillStyle, points: [...points], radii: [...radii] });
        break;
      case 'stroke':
        out.push({ op: 'stroke', style: strokeStyle, points: [...points], radii: [...radii] });
        break;
      case 'fillRect':
        out.push({
          op: 'fill',
          style: fillStyle,
          points: [
            [c[1] as number, c[2] as number],
            [(c[1] as number) + (c[3] as number), (c[2] as number) + (c[4] as number)],
          ],
          radii: [],
        });
        break;
      default:
        break;
    }
  }
  return out;
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
