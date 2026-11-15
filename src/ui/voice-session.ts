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
  /**
   * The role of every player (public table knowledge, from the host's assignment), or null when
   * none is known or no game runs. While it is set and the local role is not null, the audio of
   * the peer whose role is `mute` is muted on THIS device too: a modified mute client cannot make
   * itself heard. Peers with an unknown role are never muted. A copy is kept.
   */
  setPeerRoles(assign: Record<PeerId, Role> | null): void;
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
 * gets its stream, so a deaf player is never audible, not even for a moment. The same goes for the
 * element of the mute player's peer: its mute is set before the stream is attached.
 *
 * Mute order: `VoiceGate.setRole` first sets muted=false on every registered element and then
 * applies the role's own rule (deaf: mute all). The per-peer mutes are therefore re-applied AFTER
 * every `gate.setRole` call (`refresh`), and for a late element right after `gate.addRemote`.
 *
 * `play()` can be refused (iOS autoplay): such an element waits in `pending` and is retried on
 * the next user gesture, by one capturing listener that only exists while something is pending.
 */
export function createVoiceSession(
  conn: RoomConnection,
  micTrack: MediaStreamTrack | null,
  deps: VoiceSessionDeps = {},
): VoiceSession {
  const createAudio = deps.createAudio ?? defaultAudio;
  const gate = new VoiceGate();
  const elements = new Map<PeerId, HTMLAudioElementLike>();
  const pending = new Map<PeerId, HTMLAudioElementLike>();
  let alive = true;
  let localRole: Role | null = null;
  let peerRoles: Record<PeerId, Role> | null = null;
  gate.setLocalTrack(micTrack);

  const mutedByRole = (id: PeerId): boolean =>
    localRole !== null && peerRoles !== null && Object.hasOwn(peerRoles, id) && peerRoles[id] === 'mute';

  /** The gate's rule for the local role, then the per-peer mutes on top (the gate's restore would undo them). */
  const refresh = (): void => {
    gate.setRole(localRole);
    for (const [id, el] of elements) if (mutedByRole(id) && !el.muted) el.muted = true;
  };

  const gestures = ['pointerdown', 'pointerup', 'keydown'] as const;
  let listening = false;
  const listen = (on: boolean): void => {
    if (on === listening) return;
    listening = on;
    for (const type of gestures) {
      if (on) document.addEventListener(type, onGesture, true);
      else document.removeEventListener(type, onGesture, true);
    }
  };
  /** Starts playback; a refusal parks the element until the next gesture. Never throws. */
  const play = (id: PeerId, el: HTMLAudioElementLike): void => {
    const refused = (): void => {
      if (!alive || elements.get(id) !== el) return; // dropped meanwhile
      pending.set(id, el);
      listen(true);
    };
    try {
      void Promise.resolve(el.play()).catch(refused);
    } catch {
      refused(); // play() threw synchronously: same
    }
  };
  function onGesture(): void {
    const batch = [...pending];
    pending.clear();
    listen(false);
    for (const [id, el] of batch) if (elements.get(id) === el) play(id, el);
  }

  const drop = (id: PeerId): void => {
    const el = elements.get(id);
    if (el === undefined) return;
    elements.delete(id);
    pending.delete(id);
    if (pending.size === 0) listen(false);
    gate.removeRemote(el);
    release(el);
  };

  conn.onRemoteAudio((id, stream) => {
    if (!alive) return;
    drop(id); // a renegotiated stream replaces the old element
    const el = createAudio();
    elements.set(id, el);
    gate.addRemote(el); // first: the role's mute applies before any sound can play
    if (mutedByRole(id) && !el.muted) el.muted = true; // and so does the mute player's, before the stream
    el.srcObject = stream;
    play(id, el); // autoplay refused: the game still runs, the element is retried on a gesture
  });

  conn.onPeerLeft((id) => {
    if (alive) drop(id);
  });

  return {
    setRole(role) {
      if (!alive) return;
      localRole = role;
      refresh();
    },
    setPeerRoles(assign) {
      if (!alive) return;
      peerRoles = assign === null ? null : { ...assign };
      refresh();
    },
    destroy() {
      if (!alive) return;
      alive = false;
      gate.setRole(null);
      for (const id of [...elements.keys()]) drop(id);
      pending.clear();
      listen(false);
    },
  };
}
