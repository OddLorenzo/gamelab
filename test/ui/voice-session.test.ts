import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PeerId } from '../../src/net/protocol';
import type { RoomConnection } from '../../src/net/transport';
import { createVoiceSession } from '../../src/ui/voice-session';
import type { HTMLAudioElementLike } from '../../src/ui/voice-session';

/* ---------------------------------------------------------------- fakes */

type Log = string[];

interface FakeAudio extends HTMLAudioElementLike {
  name: string;
  paused: boolean;
}

/** Records the order of every observable step so "mute before the stream" is checkable. */
const audioFactory = (log: Log, playBehaviour: () => Promise<void> | void = () => Promise.resolve()) => {
  const made: FakeAudio[] = [];
  const createAudio = (): HTMLAudioElementLike => {
    const name = `a${String(made.length)}`;
    let muted = false;
    let srcObject: MediaProvider | null = null;
    const a: FakeAudio = {
      name,
      paused: false,
      get muted() {
        return muted;
      },
      set muted(v: boolean) {
        muted = v;
        log.push(`${name}.muted=${String(v)}`);
      },
      get srcObject() {
        return srcObject;
      },
      set srcObject(v: MediaProvider | null) {
        srcObject = v;
        log.push(`${name}.srcObject=${v === null ? 'null' : 'stream'}`);
      },
      play() {
        log.push(`${name}.play`);
        return playBehaviour();
      },
      pause() {
        a.paused = true;
        log.push(`${name}.pause`);
      },
    };
    made.push(a);
    return a;
  };
  return { made, createAudio };
};

interface FakeConn extends RoomConnection {
  remoteCbs: ((id: PeerId, s: MediaStream) => void)[];
  leftCbs: ((id: PeerId) => void)[];
  audio(id: PeerId): void;
  leave(id: PeerId): void;
}

const fakeConn = (): FakeConn => {
  const conn: FakeConn = {
    id: 'me',
    remoteCbs: [],
    leftCbs: [],
    peers: () => [],
    send: () => undefined,
    onMessage: () => undefined,
    onPeerLeft: (cb) => {
      conn.leftCbs.push(cb);
    },
    onRemoteAudio: (cb) => {
      conn.remoteCbs.push(cb);
    },
    onLinkFailed: () => undefined,
    onSignalingClosed: () => undefined,
    close: () => undefined,
    audio: (id) => {
      for (const cb of conn.remoteCbs) cb(id, {} as MediaStream);
    },
    leave: (id) => {
      for (const cb of conn.leftCbs) cb(id);
    },
  };
  return conn;
};

const rig = (mic: { enabled: boolean } | null = { enabled: true }, play?: () => Promise<void> | void) => {
  const log: Log = [];
  const conn = fakeConn();
  const { made, createAudio } = audioFactory(log, play);
  const session = createVoiceSession(conn, mic as MediaStreamTrack | null, { createAudio });
  return { log, conn, made, session, mic };
};

/* ---------------------------------------------------------------- tests */

describe('createVoiceSession', () => {
  it('registers conn.onRemoteAudio and conn.onPeerLeft exactly once, even across many roles', () => {
    const { conn, session } = rig();
    session.setRole('blind');
    session.setRole('deaf');
    session.setRole(null);
    expect(conn.remoteCbs).toHaveLength(1);
    expect(conn.leftCbs).toHaveLength(1);
  });

  it('adds the element to the gate BEFORE srcObject and play: a deaf player never has an audible window', () => {
    const { conn, log, session } = rig();
    session.setRole('deaf');
    conn.audio('p1');
    // the deaf rule mutes the element the moment the gate gets it, i.e. before the stream is attached
    expect(log).toEqual(['a0.muted=true', 'a0.srcObject=stream', 'a0.play']);
  });

  it('a deaf role mutes an element that arrives later; blind and null do not', () => {
    const { conn, made, session } = rig();
    session.setRole('deaf');
    conn.audio('p1');
    expect(made[0].muted).toBe(true);
    session.setRole('blind');
    conn.audio('p2');
    expect(made[1].muted).toBe(false);
    session.setRole(null);
    conn.audio('p3');
    expect(made[2].muted).toBe(false);
  });

  it('role rotation re-applies to the existing elements and to the mic', () => {
    const { conn, made, session, mic } = rig();
    conn.audio('p1');
    conn.audio('p2');
    session.setRole('deaf');
    expect(made.map((a) => a.muted)).toEqual([true, true]);
    expect(mic?.enabled).toBe(true);
    session.setRole('mute');
    expect(made.map((a) => a.muted)).toEqual([false, false]);
    expect(mic?.enabled).toBe(false);
    session.setRole('blind');
    expect(mic?.enabled).toBe(true);
    session.setRole(null);
    expect(made.map((a) => a.muted)).toEqual([false, false]);
    expect(mic?.enabled).toBe(true);
  });

  it('setRole before any remote audio works, and the later element obeys it', () => {
    const { conn, made, session } = rig();
    expect(() => {
      session.setRole('deaf');
    }).not.toThrow();
    conn.audio('p1');
    expect(made[0].muted).toBe(true);
  });

  it('a null mic track (permission denied) is fine for every role', () => {
    const { conn, session } = rig(null);
    expect(() => {
      session.setRole('mute');
      session.setRole('deaf');
      session.setRole(null);
      conn.audio('p1');
    }).not.toThrow();
  });

  it('a peer leaving pauses and releases only that peer element', () => {
    const { conn, made, session } = rig();
    session.setRole('blind');
    conn.audio('p1');
    conn.audio('p2');
    conn.leave('p1');
    expect(made[0].paused).toBe(true);
    expect(made[0].srcObject).toBeNull();
    expect(made[1].paused).toBe(false);
    expect(made[1].srcObject).not.toBeNull();
    // a removed element is out of the gate: a role change no longer touches it
    session.setRole('deaf');
    expect(made[0].muted).toBe(false);
    expect(made[1].muted).toBe(true);
  });

  it('a peer leaving that never had audio is harmless', () => {
    const { conn } = rig();
    expect(() => {
      conn.leave('ghost');
    }).not.toThrow();
  });

  it('a second stream from the same peer replaces and releases the first element', () => {
    const { conn, made } = rig();
    conn.audio('p1');
    conn.audio('p1');
    expect(made).toHaveLength(2);
    expect(made[0].paused).toBe(true);
    expect(made[0].srcObject).toBeNull();
    expect(made[1].paused).toBe(false);
  });

  it('destroy releases every element, opens the gate and ignores later callbacks', () => {
    const { conn, made, session, mic, log } = rig();
    session.setRole('deaf');
    conn.audio('p1');
    conn.audio('p2');
    session.destroy();
    expect(made.map((a) => a.paused)).toEqual([true, true]);
    expect(made.map((a) => a.srcObject)).toEqual([null, null]);
    expect(mic?.enabled).toBe(true);
    const before = [...log];
    conn.audio('p3');
    conn.leave('p1');
    session.setRole('mute');
    expect(made).toHaveLength(2);
    expect(log).toEqual(before);
    expect(mic?.enabled).toBe(true);
    expect(() => {
      session.destroy();
    }).not.toThrow();
  });

  it('destroy does not stop the mic track (its owner does)', () => {
    const stop = vi.fn();
    const mic = { enabled: true, stop } as unknown as MediaStreamTrack;
    const conn = fakeConn();
    const { createAudio } = audioFactory([]);
    const session = createVoiceSession(conn, mic, { createAudio });
    session.destroy();
    expect(stop).not.toHaveBeenCalled();
  });

  it('swallows a rejected play() (autoplay blocked): the rejection gets a handler', () => {
    const rejected = Promise.reject(new Error('NotAllowedError'));
    const handled = vi.spyOn(rejected, 'catch');
    const { conn, made } = rig({ enabled: true }, () => rejected);
    conn.audio('p1');
    expect(made).toHaveLength(1);
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it('swallows a play() that throws synchronously', () => {
    const { conn, made } = rig({ enabled: true }, () => {
      throw new Error('boom');
    });
    expect(() => {
      conn.audio('p1');
    }).not.toThrow();
    expect(made).toHaveLength(1);
  });
});

describe('receiver-side mute of the mute player', () => {
  const ASSIGN = { me: 'blind', p1: 'mute', p2: 'deaf' } as const;

  it('a blind listener mutes the mute peer only', () => {
    const { conn, made, session } = rig();
    conn.audio('p1');
    conn.audio('p2');
    session.setRole('blind');
    session.setPeerRoles({ ...ASSIGN });
    expect(made.map((a) => a.muted)).toEqual([true, false]);
  });

  it('a deaf listener mutes everybody (the mute peer included)', () => {
    const { conn, made, session } = rig();
    conn.audio('p1');
    conn.audio('p2');
    session.setPeerRoles({ me: 'deaf', p1: 'mute', p2: 'blind' });
    session.setRole('deaf');
    expect(made.map((a) => a.muted)).toEqual([true, true]);
  });

  it('the order of the two calls does not matter', () => {
    const a = rig();
    a.conn.audio('p1');
    a.session.setPeerRoles({ ...ASSIGN });
    a.session.setRole('blind');
    const b = rig();
    b.conn.audio('p1');
    b.session.setRole('blind');
    b.session.setPeerRoles({ ...ASSIGN });
    expect(a.made[0].muted).toBe(true);
    expect(b.made[0].muted).toBe(true);
  });

  it('a late element of the mute peer is muted BEFORE its stream is attached and played', () => {
    const { conn, log, session } = rig();
    session.setPeerRoles({ ...ASSIGN });
    session.setRole('blind');
    conn.audio('p1');
    expect(log).toEqual(['a0.muted=true', 'a0.srcObject=stream', 'a0.play']);
  });

  it('a late element of a non-mute peer is not muted for a blind listener', () => {
    const { conn, log, session } = rig();
    session.setPeerRoles({ ...ASSIGN });
    session.setRole('blind');
    conn.audio('p2');
    expect(log).toEqual(['a0.srcObject=stream', 'a0.play']);
  });

  it('a late element for the mute peer, for a deaf listener, is muted once and before the stream', () => {
    const { conn, log, session } = rig();
    session.setPeerRoles({ me: 'deaf', p1: 'mute', p2: 'blind' });
    session.setRole('deaf');
    conn.audio('p1');
    expect(log).toEqual(['a0.muted=true', 'a0.srcObject=stream', 'a0.play']);
  });

  it('the gate restoring muted=false on a role change does not unmute the mute peer', () => {
    const { conn, made, session } = rig();
    conn.audio('p1');
    conn.audio('p2');
    session.setPeerRoles({ ...ASSIGN });
    session.setRole('deaf');
    expect(made.map((a) => a.muted)).toEqual([true, true]);
    session.setRole('blind');
    expect(made.map((a) => a.muted)).toEqual([true, false]); // p2 is heard again, p1 never
    session.setRole('mute');
    expect(made.map((a) => a.muted)).toEqual([true, false]);
  });

  it('role rotation: a new assignment mutes the new mute peer and frees the old one', () => {
    const { conn, made, session } = rig();
    conn.audio('p1');
    conn.audio('p2');
    session.setRole('blind');
    session.setPeerRoles({ me: 'blind', p1: 'mute', p2: 'deaf' });
    expect(made.map((a) => a.muted)).toEqual([true, false]);
    session.setPeerRoles({ me: 'blind', p1: 'deaf', p2: 'mute' });
    expect(made.map((a) => a.muted)).toEqual([false, true]);
  });

  it('setRole(null) (lobby, results) and setPeerRoles(null) put everybody back on', () => {
    const { conn, made, session } = rig();
    conn.audio('p1');
    conn.audio('p2');
    session.setPeerRoles({ ...ASSIGN });
    session.setRole('blind');
    expect(made[0].muted).toBe(true);
    session.setRole(null);
    expect(made.map((a) => a.muted)).toEqual([false, false]);
    conn.audio('p3'); // while no role is set nothing is muted, even with the roles still known
    expect(made[2].muted).toBe(false);
    session.setRole('blind');
    expect(made[0].muted).toBe(true);
    session.setPeerRoles(null);
    expect(made.map((a) => a.muted)).toEqual([false, false, false]);
  });

  it('a peer whose role is unknown is not muted', () => {
    const { conn, made, session } = rig();
    session.setRole('blind');
    conn.audio('p1');
    conn.audio('stranger');
    session.setPeerRoles({ me: 'blind', p1: 'deaf' });
    expect(made.map((a) => a.muted)).toEqual([false, false]);
    session.setPeerRoles({});
    expect(made.map((a) => a.muted)).toEqual([false, false]);
  });

  it('inherited names are not roles: __proto__ and constructor', () => {
    const { conn, made, session } = rig();
    session.setRole('blind');
    conn.audio('__proto__');
    conn.audio('constructor');
    session.setPeerRoles({ p1: 'mute' });
    expect(made.map((a) => a.muted)).toEqual([false, false]);
  });

  it('the local mute player: own mic off and still hears the others (its rule is unchanged)', () => {
    const { conn, made, session, mic } = rig();
    conn.audio('p1');
    conn.audio('p2');
    session.setPeerRoles({ me: 'mute', p1: 'blind', p2: 'deaf' });
    session.setRole('mute');
    expect(mic?.enabled).toBe(false);
    expect(made.map((a) => a.muted)).toEqual([false, false]);
  });

  it('keeps a copy: changing the object afterwards changes nothing', () => {
    const { conn, made, session } = rig();
    conn.audio('p1');
    const roles: Record<string, 'blind' | 'deaf' | 'mute'> = { p1: 'mute' };
    session.setRole('blind');
    session.setPeerRoles(roles);
    roles['p1'] = 'deaf';
    session.setRole('blind');
    expect(made[0].muted).toBe(true);
  });

  it('after destroy setPeerRoles does nothing', () => {
    const { conn, made, session, log } = rig();
    conn.audio('p1');
    session.destroy();
    const before = [...log];
    session.setPeerRoles({ p1: 'mute' });
    expect(log).toEqual(before);
    expect(made[0].muted).toBe(false);
  });
});

describe('a refused play() is retried on the next user gesture', () => {
  const gesture = (type: string): void => {
    document.dispatchEvent(new Event(type, { bubbles: true }));
  };
  const refuse = (): Promise<void> => Promise.reject(new Error('NotAllowedError'));
  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };
  const rigPlay = (behaviour: () => Promise<void> | void) => {
    const playCalls = vi.fn(behaviour);
    return { playCalls, ...rig({ enabled: true }, playCalls) };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('nothing is listening while nothing is pending', async () => {
    const add = vi.spyOn(document, 'addEventListener');
    const { conn } = rigPlay(() => Promise.resolve());
    conn.audio('p1');
    await flush();
    expect(add).not.toHaveBeenCalled();
  });

  it('a rejected play() adds ONE capturing listener set and the next pointerdown plays again', async () => {
    const add = vi.spyOn(document, 'addEventListener');
    const { conn, playCalls } = rigPlay(refuse);
    conn.audio('p1');
    conn.audio('p2');
    await flush();
    expect(playCalls).toHaveBeenCalledTimes(2);
    const gestureAdds = add.mock.calls.filter(([type]) => type === 'pointerdown' || type === 'keydown');
    expect(gestureAdds.map((c) => c[0]).sort()).toEqual(['keydown', 'pointerdown']); // once, not once per element
    expect(gestureAdds.every((c) => c[2] === true)).toBe(true); // capturing
    playCalls.mockImplementation(() => Promise.resolve());
    gesture('pointerdown');
    await flush();
    expect(playCalls).toHaveBeenCalledTimes(4); // both pending elements retried
  });

  it('keydown retries too, and nothing listens once everything plays', async () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    const { conn, playCalls } = rigPlay(refuse);
    conn.audio('p1');
    await flush();
    playCalls.mockImplementation(() => Promise.resolve());
    gesture('keydown');
    await flush();
    expect(playCalls).toHaveBeenCalledTimes(2);
    expect(remove.mock.calls.filter(([type]) => type === 'keydown' || type === 'pointerdown').length).toBeGreaterThanOrEqual(2);
    gesture('keydown');
    gesture('pointerdown');
    await flush();
    expect(playCalls).toHaveBeenCalledTimes(2); // nothing pending, nothing listening
  });

  it('pointerup counts too: on touch screens only the release is a user activation', async () => {
    const { conn, playCalls } = rigPlay(refuse);
    conn.audio('p1');
    await flush();
    gesture('pointerdown'); // refused again: no activation yet
    await flush();
    playCalls.mockImplementation(() => Promise.resolve());
    gesture('pointerup');
    await flush();
    expect(playCalls).toHaveBeenCalledTimes(3);
    gesture('pointerup');
    await flush();
    expect(playCalls).toHaveBeenCalledTimes(3);
  });

  it('a retry that is refused again is swallowed and the element waits for the next gesture', async () => {
    const { conn, playCalls } = rigPlay(refuse);
    conn.audio('p1');
    await flush();
    gesture('pointerdown');
    await flush();
    expect(playCalls).toHaveBeenCalledTimes(2);
    gesture('pointerdown');
    await flush();
    expect(playCalls).toHaveBeenCalledTimes(3);
  });

  it('a play() that throws synchronously is retried the same way', async () => {
    let n = 0;
    const { conn, playCalls } = rigPlay(() => {
      if (n++ === 0) throw new Error('boom');
    });
    conn.audio('p1');
    await flush();
    gesture('pointerdown');
    await flush();
    expect(playCalls).toHaveBeenCalledTimes(2);
    gesture('pointerdown');
    await flush();
    expect(playCalls).toHaveBeenCalledTimes(2);
  });

  it('a peer that left is not retried, and its listener goes when nothing else is pending', async () => {
    const { conn, playCalls } = rigPlay(refuse);
    conn.audio('p1');
    conn.audio('p2');
    await flush();
    conn.leave('p1');
    gesture('pointerdown');
    await flush();
    expect(playCalls).toHaveBeenCalledTimes(3); // p2 only
    conn.leave('p2');
    gesture('pointerdown');
    await flush();
    expect(playCalls).toHaveBeenCalledTimes(3);
  });

  it('destroy removes the listeners and drops the pending elements', async () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    const { conn, playCalls, session } = rigPlay(refuse);
    conn.audio('p1');
    await flush();
    session.destroy();
    expect(remove.mock.calls.filter(([type]) => type === 'pointerdown')).toHaveLength(1);
    gesture('pointerdown');
    await flush();
    expect(playCalls).toHaveBeenCalledTimes(1);
  });

  it('a refusal that arrives after the peer left parks nothing', async () => {
    const add = vi.spyOn(document, 'addEventListener');
    let reject: (e: Error) => void = () => undefined;
    const { conn } = rigPlay(() => new Promise<void>((_res, rej) => (reject = rej)));
    conn.audio('p1');
    conn.leave('p1');
    reject(new Error('NotAllowedError'));
    await flush();
    expect(add).not.toHaveBeenCalled();
  });

  it('a retried element keeps its mute: the mute peer stays silent while it waits', async () => {
    const { conn, made, session, playCalls } = rigPlay(refuse);
    session.setPeerRoles({ me: 'blind', p1: 'mute' });
    session.setRole('blind');
    conn.audio('p1');
    await flush();
    playCalls.mockImplementation(() => Promise.resolve());
    gesture('pointerdown');
    await flush();
    expect(made[0].muted).toBe(true);
  });
});
