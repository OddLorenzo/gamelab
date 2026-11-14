import type { LevelDef } from '../core/bomb';
import type { BlindView, DeafView, MuteView } from '../core/views';
import type { ModuleAction, ModuleKind, Role } from '../core/types';

export type PeerId = string;

/** Same list the emote UI reuses. */
export const EMOTE_IDS = ['point', 'wave', 'slap', 'panic', 'yes', 'no'] as const;
export type EmoteId = (typeof EMOTE_IDS)[number];

export type EndReason = 'won' | 'lost' | 'host-left' | 'player-left';

export interface EndStats {
  strikesLeft: number;
  /** session.msLeft / def.timeMs, 0..1 */
  msLeftRatio: number;
}

export type RoleView = BlindView | DeafView | MuteView;

export type NetMsg =
  | { t: 'roles'; assign: Record<PeerId, Role>; level: LevelDef }
  | { t: 'view'; seq: number; hostTimeMs: number; view: RoleView }
  | { t: 'act'; moduleId: string; action: ModuleAction }
  | { t: 'pointer'; x: number; y: number; by?: PeerId } // normalized 0..1; `by` set by the host when relaying
  | { t: 'emote'; id: EmoteId; by?: PeerId }
  | { t: 'heartbeat'; hostTimeMs: number }
  | { t: 'ended'; reason: EndReason; stats?: EndStats };

/** What the local player can do, identical for the host (as a player) and for a guest. */
export interface Participant {
  onView(cb: (v: RoleView, msLeft: number | null) => void): void;
  onEnded(cb: (reason: EndReason, stats?: EndStats) => void): void;
  /** Seconds-accurate timer for the deaf player, null for the other roles. */
  msLeft(): number | null;
  act(moduleId: string, action: ModuleAction): void;
  sendPointer(x: number, y: number): void;
  sendEmote(id: EmoteId): void;
  onPointer(cb: (by: PeerId, x: number, y: number) => void): void;
  onEmote(cb: (by: PeerId, id: EmoteId) => void): void;
}

const MODULE_KINDS: readonly ModuleKind[] = ['wires', 'button', 'symbols', 'code'];
const ROLES: readonly Role[] = ['blind', 'deaf', 'mute'];
const STATUSES = ['playing', 'won', 'lost'] as const;
const END_REASONS: readonly EndReason[] = ['won', 'lost', 'host-left', 'player-left'];

const MAX_ID_LENGTH = 64;
const MAX_PAYLOAD_JSON = 1024;
const MAX_PLAYERS = 3;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
const own = (o: Obj, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isId = (v: unknown): v is string => isStr(v) && v.length > 0 && v.length <= MAX_ID_LENGTH;
const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  isStr(v) && (list as readonly string[]).includes(v);

const parseLevel = (v: unknown): LevelDef | null => {
  if (!isObj(v)) return null;
  const kinds = own(v, 'moduleKinds');
  if (!Array.isArray(kinds) || kinds.length > 16 || !kinds.every((k) => isOneOf(MODULE_KINDS, k))) return null;
  const id = own(v, 'id');
  const stage = own(v, 'stage');
  const seed = own(v, 'seed');
  const difficulty = own(v, 'difficulty');
  const timeMs = own(v, 'timeMs');
  const strikes = own(v, 'strikes');
  const setting = own(v, 'setting');
  if (!isNum(id) || !isNum(stage) || !isNum(seed) || !isNum(difficulty) || !isNum(timeMs) || !isNum(strikes)) {
    return null;
  }
  if (!isStr(setting) || setting.length > MAX_ID_LENGTH) return null;
  return { id, stage, seed, moduleKinds: [...kinds] as ModuleKind[], difficulty, timeMs, strikes, setting };
};

const validStatus = (v: unknown): boolean => isOneOf(STATUSES, v);

const arrayOf = (v: unknown, ok: (item: unknown) => boolean): boolean =>
  Array.isArray(v) && v.length <= 64 && v.every(ok);

const validModuleState = (m: unknown): boolean =>
  isObj(m) &&
  isOneOf(MODULE_KINDS, own(m, 'kind')) &&
  isStr(own(m, 'id')) &&
  typeof own(m, 'solved') === 'boolean' &&
  isObj(own(m, 'data'));

/** Structural check only: the views come from the host, which projects them from its own session. */
const parseView = (v: unknown): RoleView | null => {
  if (!isObj(v) || !isNum(own(v, 'strikesLeft')) || !validStatus(own(v, 'status'))) return null;
  switch (own(v, 'role')) {
    case 'blind':
      return own(v, 'msLeftBucket') === null &&
        arrayOf(own(v, 'targets'), (t) =>
          isObj(t) && isStr(own(t, 'moduleId')) && isOneOf(MODULE_KINDS, own(t, 'kind')) && isNum(own(t, 'slots')),
        )
        ? (v as unknown as BlindView)
        : null;
    case 'deaf':
      return isNum(own(v, 'msLeft')) && arrayOf(own(v, 'modules'), validModuleState)
        ? (v as unknown as DeafView)
        : null;
    case 'mute':
      return arrayOf(own(v, 'manual'), (e) =>
        isObj(e) &&
        isOneOf(MODULE_KINDS, own(e, 'kind')) &&
        isStr(own(e, 'titleKey')) &&
        arrayOf(own(e, 'rules'), isStr),
      )
        ? (v as unknown as MuteView)
        : null;
    default:
      return null;
  }
};

const parseAction = (v: unknown): ModuleAction | null => {
  if (!isObj(v)) return null;
  const kind = own(v, 'kind');
  const type = own(v, 'type');
  if (!isOneOf(MODULE_KINDS, kind) || !isId(type)) return null;
  const payload = own(v, 'payload');
  if (payload === undefined) return { kind, type };
  if (!isObj(payload) || JSON.stringify(payload).length > MAX_PAYLOAD_JSON) return null;
  return { kind, type, payload };
};

const parseStats = (v: unknown): EndStats | null => {
  if (!isObj(v)) return null;
  const strikesLeft = own(v, 'strikesLeft');
  const msLeftRatio = own(v, 'msLeftRatio');
  return isNum(strikesLeft) && isNum(msLeftRatio) ? { strikesLeft, msLeftRatio } : null;
};

const parseBy = (o: Obj): { ok: boolean; by?: PeerId } => {
  const by = own(o, 'by');
  if (by === undefined) return { ok: true };
  return isId(by) ? { ok: true, by } : { ok: false };
};

/**
 * Validates untrusted input (a decoded data-channel frame) and returns a clean NetMsg built
 * from known fields only, or null for anything malformed. Never throws.
 */
export function parseNetMsg(raw: unknown): NetMsg | null {
  try {
    return parse(raw);
  } catch {
    return null;
  }
}

function parse(raw: unknown): NetMsg | null {
  if (!isObj(raw)) return null;
  switch (own(raw, 't')) {
    case 'roles': {
      const assign = own(raw, 'assign');
      const level = parseLevel(own(raw, 'level'));
      if (!isObj(assign) || level === null) return null;
      const entries = Object.entries(assign);
      if (entries.length === 0 || entries.length > MAX_PLAYERS) return null;
      if (!entries.every(([id, role]) => isId(id) && isOneOf(ROLES, role))) return null;
      return { t: 'roles', assign: Object.fromEntries(entries) as Record<PeerId, Role>, level };
    }
    case 'view': {
      const seq = own(raw, 'seq');
      const hostTimeMs = own(raw, 'hostTimeMs');
      const view = parseView(own(raw, 'view'));
      if (!isInt(seq) || !isNum(hostTimeMs) || view === null) return null;
      return { t: 'view', seq, hostTimeMs, view };
    }
    case 'act': {
      const moduleId = own(raw, 'moduleId');
      const action = parseAction(own(raw, 'action'));
      if (!isId(moduleId) || action === null) return null;
      return { t: 'act', moduleId, action };
    }
    case 'pointer': {
      const x = own(raw, 'x');
      const y = own(raw, 'y');
      const { ok, by } = parseBy(raw);
      if (!isNum(x) || !isNum(y) || !ok) return null;
      return by === undefined ? { t: 'pointer', x, y } : { t: 'pointer', x, y, by };
    }
    case 'emote': {
      const id = own(raw, 'id');
      const { ok, by } = parseBy(raw);
      if (!isOneOf(EMOTE_IDS, id) || !ok) return null;
      return by === undefined ? { t: 'emote', id } : { t: 'emote', id, by };
    }
    case 'heartbeat': {
      const hostTimeMs = own(raw, 'hostTimeMs');
      return isNum(hostTimeMs) ? { t: 'heartbeat', hostTimeMs } : null;
    }
    case 'ended': {
      const reason = own(raw, 'reason');
      if (!isOneOf(END_REASONS, reason)) return null;
      const rawStats = own(raw, 'stats');
      if (rawStats === undefined) return { t: 'ended', reason };
      const stats = parseStats(rawStats);
      return stats === null ? null : { t: 'ended', reason, stats };
    }
    default:
      return null;
  }
}
