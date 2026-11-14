import type { Role } from '../core/types';

/** mute: the local mic is switched off. deaf: every remote audio element is muted. blind: nothing. */
export function applyVoiceRules(
  role: Role,
  localTrack: { enabled: boolean } | null,
  remoteAudio: { muted: boolean }[],
): void {
  if (role === 'mute') {
    if (localTrack) localTrack.enabled = false;
  } else if (role === 'deaf') {
    for (const el of remoteAudio) el.muted = true;
  }
}

/** The microphone is the only permission the game asks for. Resolves null on any failure. */
export async function requestMic(): Promise<MediaStreamTrack | null> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return stream.getAudioTracks()[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Keeps the voice rules in force as roles rotate and as audio elements or the mic track arrive.
 * A null role (no level running) lets everyone talk and hear.
 */
export class VoiceGate {
  private role: Role | null = null;
  private track: { enabled: boolean } | null = null;
  private readonly remotes = new Set<{ muted: boolean }>();

  setRole(role: Role | null): void {
    this.role = role;
    if (this.track) this.track.enabled = true;
    for (const el of this.remotes) el.muted = false;
    if (role) applyVoiceRules(role, this.track, [...this.remotes]);
  }

  setLocalTrack(track: { enabled: boolean } | null): void {
    this.track = track;
    if (track && this.role) applyVoiceRules(this.role, track, []);
  }

  addRemote(el: { muted: boolean }): void {
    this.remotes.add(el);
    if (this.role) applyVoiceRules(this.role, null, [el]);
  }

  removeRemote(el: { muted: boolean }): void {
    this.remotes.delete(el);
  }
}
