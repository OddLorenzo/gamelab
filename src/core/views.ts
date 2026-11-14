import type { ManualEntry, ModuleKind, ModuleState, Role } from './types';
import { MODULES } from './bomb';
import type { Session } from './bomb';

export interface BlindView {
  role: 'blind';
  targets: { moduleId: string; kind: ModuleKind; slots: number }[];
  msLeftBucket: null;
  strikesLeft: number;
  status: Session['status'];
}

export interface DeafView {
  role: 'deaf';
  modules: ModuleState[];
  msLeft: number;
  strikesLeft: number;
  status: Session['status'];
}

export interface MuteView {
  role: 'mute';
  manual: ManualEntry[];
  strikesLeft: number;
  status: Session['status'];
}

const CODE_SLOTS = 12; // 0-9 digits, 10 clear, 11 submit
const SYMBOLS_SLOTS = 4;

const slotsOf = (m: ModuleState): number => {
  switch (m.kind) {
    case 'wires':
      return (m.data['wires'] as unknown[]).length;
    case 'button':
      return 1;
    case 'symbols':
      return SYMBOLS_SLOTS;
    case 'code':
      return CODE_SLOTS;
  }
};

/** Copy of the module state without the field that would give the solution away. */
const redact = (m: ModuleState): ModuleState => {
  if (m.kind === 'code') {
    const { target: _target, ...data } = m.data;
    return { ...m, data };
  }
  if (m.kind === 'symbols') {
    const { order: _order, ...data } = m.data;
    return { ...m, data };
  }
  return m;
};

export function projectView(s: Session, role: Role): BlindView | DeafView | MuteView {
  switch (role) {
    case 'blind':
      return {
        role: 'blind',
        targets: s.modules.map((m) => ({ moduleId: m.id, kind: m.kind, slots: slotsOf(m) })),
        msLeftBucket: null,
        strikesLeft: s.strikesLeft,
        status: s.status,
      };
    case 'deaf':
      return {
        role: 'deaf',
        modules: s.modules.map(redact),
        msLeft: s.msLeft,
        strikesLeft: s.strikesLeft,
        status: s.status,
      };
    case 'mute': {
      const kinds = [...new Set(s.modules.map((m) => m.kind))];
      return {
        role: 'mute',
        manual: kinds.map((k) => MODULES[k].manual()),
        strikesLeft: s.strikesLeft,
        status: s.status,
      };
    }
  }
}
