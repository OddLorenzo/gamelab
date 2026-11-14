import { describe, expect, it, vi } from 'vitest';
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
