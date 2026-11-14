import type { BombModule, ModuleAction, ModuleKind, ModuleState, Role } from './types';
import { createRng } from './rng';
import { wiresModule } from './modules/wires';
import { buttonModule } from './modules/button';
import { symbolsModule } from './modules/symbols';
import { codeModule } from './modules/code';

export const MODULES: Record<ModuleKind, BombModule> = {
  wires: wiresModule,
  button: buttonModule,
  symbols: symbolsModule,
  code: codeModule,
};

export interface LevelDef {
  id: number;
  stage: number;
  seed: number;
  moduleKinds: ModuleKind[];
  difficulty: number;
  timeMs: number;
  strikes: number;
  setting: string;
}

export interface Session {
  levelId: number;
  modules: ModuleState[];
  strikesLeft: number;
  msLeft: number;
  status: 'playing' | 'won' | 'lost';
}

export type SessionEvent =
  | { type: 'act'; role: Role; moduleId: string; action: ModuleAction }
  | { type: 'tick'; dtMs: number };

export function createSession(def: LevelDef): Session {
  const rng = createRng(def.seed); // one rng per session, consumed in module order
  return {
    levelId: def.id,
    modules: def.moduleKinds.map((kind, i) => MODULES[kind].init(`m${i}`, rng, def.difficulty)),
    strikesLeft: def.strikes,
    msLeft: def.timeMs,
    status: 'playing',
  };
}

/**
 * Pure reducer. Returns the SAME session object for every ignored event: a finished
 * session, an act from a non-blind role, an act on an unknown module or with an action
 * of another kind, and a tick whose dtMs is not a positive number (0, negative, NaN:
 * time never runs backwards). A dtMs of Infinity is accepted and simply runs the clock out.
 * The reducer never touches `timerDigit`: the host injects the real one into button payloads.
 */
export function reduce(s: Session, ev: SessionEvent): Session {
  if (s.status !== 'playing') return s;

  if (ev.type === 'tick') {
    if (!(ev.dtMs > 0)) return s;
    const msLeft = Math.max(0, s.msLeft - ev.dtMs);
    return { ...s, msLeft, status: msLeft === 0 ? 'lost' : 'playing' };
  }

  if (ev.role !== 'blind') return s;
  const index = s.modules.findIndex((m) => m.id === ev.moduleId);
  if (index < 0) return s;
  const current = s.modules[index];
  if (ev.action.kind !== current.kind) return s;

  const { state, outcome } = MODULES[current.kind].act(current, ev.action);
  const modules = s.modules.map((m, i) => (i === index ? state : m));
  const strikesLeft = outcome === 'strike' ? Math.max(0, s.strikesLeft - 1) : s.strikesLeft;
  let status: Session['status'] = 'playing';
  if (outcome === 'strike' && strikesLeft === 0) status = 'lost';
  else if (modules.every((m) => m.solved)) status = 'won';
  return { ...s, modules, strikesLeft, status };
}
