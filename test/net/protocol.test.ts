import { describe, it, expect } from 'vitest';
import { EMOTE_IDS, parseNetMsg } from '../../src/net/protocol';
import { createSession } from '../../src/core/bomb';
import type { LevelDef } from '../../src/core/bomb';
import { projectView } from '../../src/core/views';

const level: LevelDef = {
  id: 1,
  stage: 1,
  seed: 5,
  moduleKinds: ['wires', 'button', 'symbols', 'code'],
  difficulty: 3,
  timeMs: 60_000,
  strikes: 3,
  setting: 'jungle',
};
const session = createSession(level);
const blind = projectView(session, 'blind');
const deaf = projectView(session, 'deaf');
const mute = projectView(session, 'mute');

const valid: [string, unknown][] = [
  ['roles', { t: 'roles', assign: { a: 'blind', b: 'deaf', c: 'mute' }, level }],
  ['view blind', { t: 'view', seq: 1, hostTimeMs: 10, view: blind }],
  ['view deaf', { t: 'view', seq: 2, hostTimeMs: 10, view: deaf }],
  ['view mute', { t: 'view', seq: 3, hostTimeMs: 10, view: mute }],
  ['act without payload', { t: 'act', moduleId: 'm0', action: { kind: 'wires', type: 'cut' } }],
  ['act with payload', { t: 'act', moduleId: 'm0', action: { kind: 'wires', type: 'cut', payload: { index: 2 } } }],
  ['act code', { t: 'act', moduleId: 'm3', action: { kind: 'code', type: 'submit' } }],
  ['pointer', { t: 'pointer', x: 0.5, y: 0.25 }],
  ['pointer with by', { t: 'pointer', x: 0, y: 1, by: 'abcd1234' }],
  ['emote', { t: 'emote', id: 'wave' }],
  ['emote with by', { t: 'emote', id: 'panic', by: 'abcd1234' }],
  ['heartbeat', { t: 'heartbeat', hostTimeMs: 12345 }],
  ['ended won', { t: 'ended', reason: 'won' }],
  ['ended lost with stats', { t: 'ended', reason: 'lost', stats: { strikesLeft: 1, msLeftRatio: 0.5 } }],
  ['ended player-left', { t: 'ended', reason: 'player-left' }],
  ['ended host-left', { t: 'ended', reason: 'host-left' }],
];

const act = { t: 'act', moduleId: 'm0', action: { kind: 'wires', type: 'cut' } };
const withAction = (over: Record<string, unknown>): unknown => ({
  ...act,
  action: { ...act.action, ...over },
});
const invalid: [string, unknown][] = [
  ['null', null],
  ['undefined', undefined],
  ['string', 'hello'],
  ['number', 3],
  ['array', [{ t: 'heartbeat', hostTimeMs: 1 }]],
  ['empty object', {}],
  ['missing t', { hostTimeMs: 1 }],
  ['numeric t', { t: 1 }],
  ['unknown t', { t: 'nuke' }],
  ['inherited t', Object.create({ t: 'heartbeat', hostTimeMs: 1 })],
  ['roles without level', { t: 'roles', assign: { a: 'blind' } }],
  ['roles bad role value', { t: 'roles', assign: { a: 'king' }, level }],
  ['roles assign array', { t: 'roles', assign: ['blind'], level }],
  ['roles too many players', { t: 'roles', assign: { a: 'blind', b: 'deaf', c: 'mute', d: 'mute' }, level }],
  ['roles level bad kind', { t: 'roles', assign: { a: 'blind' }, level: { ...level, moduleKinds: ['lasers'] } }],
  ['roles level NaN time', { t: 'roles', assign: { a: 'blind' }, level: { ...level, timeMs: NaN } }],
  ['roles level numeric setting', { t: 'roles', assign: { a: 'blind' }, level: { ...level, setting: 3 } }],
  ['view without view', { t: 'view', seq: 1, hostTimeMs: 1 }],
  ['view seq string', { t: 'view', seq: '1', hostTimeMs: 1, view: blind }],
  ['view seq fractional', { t: 'view', seq: 1.5, hostTimeMs: 1, view: blind }],
  ['view hostTime NaN', { t: 'view', seq: 1, hostTimeMs: NaN, view: blind }],
  ['view unknown role', { t: 'view', seq: 1, hostTimeMs: 1, view: { ...blind, role: 'god' } }],
  ['view deaf modules not array', { t: 'view', seq: 1, hostTimeMs: 1, view: { ...deaf, modules: 'x' } }],
  ['view deaf null msLeft', { t: 'view', seq: 1, hostTimeMs: 1, view: { ...deaf, msLeft: null } }],
  ['view blind bad status', { t: 'view', seq: 1, hostTimeMs: 1, view: { ...blind, status: 'lol' } }],
  ['view mute manual not array', { t: 'view', seq: 1, hostTimeMs: 1, view: { ...mute, manual: {} } }],
  ['act without moduleId', { t: 'act', action: { kind: 'wires', type: 'cut' } }],
  ['act numeric moduleId', { ...act, moduleId: 0 }],
  ['act without action', { t: 'act', moduleId: 'm0' }],
  ['act null action', { ...act, action: null }],
  ['act unknown kind', withAction({ kind: 'lasers' })],
  ['act numeric type', withAction({ type: 7 })],
  ['act payload string', withAction({ payload: 'x' })],
  ['act payload array', withAction({ payload: [1] })],
  ['act payload null', withAction({ payload: null })],
  ['act payload huge', withAction({ payload: { blob: 'x'.repeat(5000) } })],
  ['act moduleId huge', { ...act, moduleId: 'm'.repeat(500) }],
  ['pointer NaN x', { t: 'pointer', x: NaN, y: 0 }],
  ['pointer Infinity y', { t: 'pointer', x: 0, y: Infinity }],
  ['pointer string x', { t: 'pointer', x: '0.5', y: 0 }],
  ['pointer missing y', { t: 'pointer', x: 0.5 }],
  ['pointer numeric by', { t: 'pointer', x: 0, y: 0, by: 7 }],
  ['emote unknown id', { t: 'emote', id: 'dance' }],
  ['emote numeric id', { t: 'emote', id: 1 }],
  ['emote missing id', { t: 'emote' }],
  ['heartbeat string time', { t: 'heartbeat', hostTimeMs: '1' }],
  ['heartbeat NaN time', { t: 'heartbeat', hostTimeMs: NaN }],
  ['ended unknown reason', { t: 'ended', reason: 'boom' }],
  ['ended missing reason', { t: 'ended' }],
  ['ended stats string', { t: 'ended', reason: 'won', stats: 'x' }],
  ['ended stats NaN', { t: 'ended', reason: 'won', stats: { strikesLeft: NaN, msLeftRatio: 0.5 } }],
];

describe('parseNetMsg', () => {
  it.each(valid)('accepts a valid %s message', (_name, raw) => {
    const wire = JSON.parse(JSON.stringify(raw)) as unknown;
    expect(parseNetMsg(wire)).toEqual(wire);
  });

  it.each(invalid)('rejects %s', (_name, raw) => {
    expect(parseNetMsg(raw)).toBeNull();
  });

  it('accepts every emote id and nothing else', () => {
    expect([...EMOTE_IDS]).toEqual(['point', 'wave', 'slap', 'panic', 'yes', 'no']);
    for (const id of EMOTE_IDS) expect(parseNetMsg({ t: 'emote', id })).toEqual({ t: 'emote', id });
  });

  it('accepts every module kind in an act', () => {
    for (const kind of ['wires', 'button', 'symbols', 'code']) {
      expect(parseNetMsg(withAction({ kind }))).not.toBeNull();
    }
  });

  it('drops unknown extra fields from act, so a forged role never survives parsing', () => {
    const forged = { ...act, role: 'blind', extra: 1, action: { ...act.action, role: 'blind' } };
    expect(parseNetMsg(forged)).toEqual(act);
  });

  it('never throws on hostile input', () => {
    const action: Record<string, unknown> = { kind: 'wires', type: 'cut' };
    const cyclic = { t: 'act', moduleId: 'm0', action };
    action['payload'] = cyclic;
    expect(() => parseNetMsg(cyclic)).not.toThrow();
    expect(parseNetMsg(cyclic)).toBeNull();
    const throwing = new Proxy({}, {
      get: () => {
        throw new Error('boom');
      },
    });
    expect(() => parseNetMsg(throwing)).not.toThrow();
    expect(parseNetMsg(throwing)).toBeNull();
  });
});
