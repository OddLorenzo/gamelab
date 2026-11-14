import type { ModuleKind } from './types';
import { MODULES, createSession, reduce } from './bomb';
import type { LevelDef, Session } from './bomb';

export const STAGE_SIZE = 10;
const MAX_LEVEL = 100;

/** i18n keys of the 10 original settings, one per stage: SETTINGS[stage - 1]. */
export const SETTINGS: readonly string[] = [
  'setting.jungle',
  'setting.temple',
  'setting.harbor',
  'setting.market',
  'setting.volcano',
  'setting.cavern',
  'setting.treehouse',
  'setting.shipwreck',
  'setting.fairground',
  'setting.summit',
];

/** Order in which module kinds are introduced; level N uses the first KIND_COUNT[N-1] of them. */
const KIND_ORDER: readonly ModuleKind[] = ['wires', 'button', 'symbols', 'code'];

/**
 * Stage 1 curve, ids 1..10. Each level adds at most one step on one axis (one more
 * module kind or +1 difficulty); plateau levels only get less time.
 */
const KIND_COUNT: readonly number[] = [1, 1, 2, 2, 2, 3, 3, 3, 4, 4];
const DIFFICULTY: readonly number[] = [1, 2, 2, 2, 3, 3, 3, 4, 4, 4];

const START_TIME_MS = 180_000; // level 1
const STAGE1_STEP_MS = 5_000; // lost per level in ids 2..10
const LATER_STEP_MS = 1_000; // lost per level after id 10
const MIN_TIME_MS = 60_000;
const MAX_DIFFICULTY = 5;

const timeFor = (id: number): number => {
  if (id <= STAGE_SIZE) return START_TIME_MS - STAGE1_STEP_MS * (id - 1);
  const afterStage1 = START_TIME_MS - STAGE1_STEP_MS * (STAGE_SIZE - 1);
  return Math.max(MIN_TIME_MS, afterStage1 - LATER_STEP_MS * (id - STAGE_SIZE));
};

/** 3 strikes in stages 1-3, 2 in stages 4-6, 1 from stage 7 on. Never below 1. */
const strikesFor = (stage: number): number => (stage <= 3 ? 3 : stage <= 6 ? 2 : 1);

export function buildLevel(id: number): LevelDef {
  if (!Number.isInteger(id) || id < 1 || id > MAX_LEVEL) {
    throw new RangeError(`Level id must be an integer from 1 to ${MAX_LEVEL}, got ${String(id)}`);
  }
  const stage = Math.ceil(id / STAGE_SIZE);
  const inStage1 = id <= STAGE_SIZE;
  return {
    id,
    stage,
    seed: id * 7919 + 13,
    moduleKinds: KIND_ORDER.slice(0, inStage1 ? KIND_COUNT[id - 1] : KIND_ORDER.length),
    difficulty: inStage1 ? DIFFICULTY[id - 1] : MAX_DIFFICULTY,
    timeMs: timeFor(id),
    strikes: strikesFor(stage),
    setting: SETTINGS[stage - 1],
  };
}

/**
 * True only when playing every module's own solve() sequence as the blind role, with no
 * tick, wins the level without using a strike or any time. An empty module list, an
 * unknown kind, no time, or no strikes are never solvable.
 */
export function isSolvable(def: LevelDef): boolean {
  if (def.moduleKinds.length === 0 || def.timeMs <= 0 || def.strikes < 1) return false;
  if (!def.moduleKinds.every((kind) => Object.hasOwn(MODULES, kind))) return false;

  let session: Session = createSession(def);
  for (const module of session.modules) {
    for (const action of MODULES[module.kind].solve(module)) {
      session = reduce(session, { type: 'act', role: 'blind', moduleId: module.id, action });
    }
  }
  return session.status === 'won' && session.strikesLeft === def.strikes && session.msLeft === def.timeMs;
}
