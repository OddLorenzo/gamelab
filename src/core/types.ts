export type Role = 'blind' | 'deaf' | 'mute';
export type ModuleKind = 'wires' | 'button' | 'symbols' | 'code';

export interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
}

export type Outcome = 'progress' | 'solved' | 'strike';

export interface ModuleState {
  kind: ModuleKind;
  id: string;
  solved: boolean;
  data: Record<string, unknown>;
}

export interface ModuleAction {
  kind: ModuleKind;
  type: string;
  payload?: Record<string, unknown>;
}

export interface ActResult {
  state: ModuleState;
  outcome: Outcome;
}

export interface ManualEntry {
  kind: ModuleKind;
  titleKey: string;
  rules: string[];
}

export interface BombModule {
  kind: ModuleKind;
  init(id: string, rng: Rng, difficulty: number): ModuleState;
  act(state: ModuleState, action: ModuleAction): ActResult;
  manual(): ManualEntry; // static rules, same for all bombs
  solve(state: ModuleState): ModuleAction[]; // winning action sequence, used by tests and level check
}
