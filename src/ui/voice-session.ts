import type { Role } from '../core/types';
import type { PeerId } from '../net/protocol';
import type { RoomConnection } from '../net/transport';
import { VoiceGate } from '../net/voice';

/** The part of HTMLAudioElement the session uses, so tests can pass a recording fake. */
export interface HTMLAudioElementLike {
  muted: boolean;
  srcObject: MediaProvider | null;
  play(): Promise<void> | void;
  pause(): void;
}

export interface VoiceSession {
  /** null (lobby, results): everybody may talk and hear. A role: the voice rules of that role. */
  setRole(role: Role | null): void;
  /** Releases every audio element and opens the gate. Never stops the mic track: its owner does. */
  destroy(): void;
}

export interface VoiceSessionDeps {
  createAudio?: () => HTMLAudioElementLike;
}

const defaultAudio = (): HTMLAudioElementLike => {
  const a = new Audio();
  a.autoplay = true;
  return a;
};

const release = (el: HTMLAudioElementLike): void => {
  try {
    el.pause();
  } catch {
    // an element that cannot pause is dropped anyway
  }
  el.srcObject = null;
};

/**
 * The voice of one room connection: exactly ONE per RoomConnection (the connection's callbacks
 * cannot be unregistered). Remote streams get an audio element that goes into the gate BEFORE it
 * gets its stream, so a deaf player is never audible, not even for a moment.
 */
export function createVoiceSession(
  conn: RoomConnection,
  micTrack: MediaStreamTrack | null,
  deps: VoiceSessionDeps = {},
): VoiceSession {
  const createAudio = deps.createAudio ?? defaultAudio;
  const gate = new VoiceGate();
  const elements = new Map<PeerId, HTMLAudioElementLike>();
  let alive = true;
  gate.setLocalTrack(micTrack);

  const drop = (id: PeerId): void => {
    const el = elements.get(id);
    if (el === undefined) return;
    elements.delete(id);
    gate.removeRemote(el);
    release(el);
  };

  conn.onRemoteAudio((id, stream) => {
    if (!alive) return;
    drop(id); // a renegotiated stream replaces the old element
    const el = createAudio();
    elements.set(id, el);
    gate.addRemote(el); // first: the role's mute applies before any sound can play
    el.srcObject = stream;
    try {
      void Promise.resolve(el.play()).catch(() => undefined); // autoplay refused: the game still runs
    } catch {
      // play() threw synchronously: same
    }
  });

  conn.onPeerLeft((id) => {
    if (alive) drop(id);
  });

  return {
    setRole(role) {
      if (alive) gate.setRole(role);
    },
    destroy() {
      if (!alive) return;
      alive = false;
      gate.setRole(null);
      for (const id of [...elements.keys()]) drop(id);
    },
  };
}
