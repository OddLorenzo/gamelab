import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceGate, applyVoiceRules, requestMic } from '../../src/net/voice';

const track = (enabled = true) => ({ enabled });
const remotes = (n: number, muted = false) => Array.from({ length: n }, () => ({ muted }));

describe('applyVoiceRules', () => {
  it('mute disables the local track and leaves every remote unmuted', () => {
    const t = track(true);
    const r = remotes(3, false);
    applyVoiceRules('mute', t, r);
    expect(t.enabled).toBe(false);
    expect(r.map((e) => e.muted)).toEqual([false, false, false]);
  });

  it('deaf mutes every remote and leaves the local track enabled', () => {
    const t = track(true);
    const r = remotes(3, false);
    applyVoiceRules('deaf', t, r);
    expect(r.map((e) => e.muted)).toEqual([true, true, true]);
    expect(t.enabled).toBe(true);
  });

  it('blind changes nothing, neither the track nor the elements', () => {
    const t = track(false);
    const r = remotes(2, true);
    applyVoiceRules('blind', t, r);
    expect(t.enabled).toBe(false);
    expect(r.map((e) => e.muted)).toEqual([true, true]);

    const t2 = track(true);
    const r2 = remotes(2, false);
    applyVoiceRules('blind', t2, r2);
    expect(t2.enabled).toBe(true);
    expect(r2.map((e) => e.muted)).toEqual([false, false]);
  });

  it('does not throw for a null track or an empty list', () => {
    expect(() => applyVoiceRules('mute', null, [])).not.toThrow();
    expect(() => applyVoiceRules('deaf', null, [])).not.toThrow();
    expect(() => applyVoiceRules('blind', null, [])).not.toThrow();
  });

  it('mic denied (null track): the mute role is unaffected and the deaf role still mutes remotes', () => {
    const r = remotes(2, false);
    expect(() => applyVoiceRules('mute', null, r)).not.toThrow();
    expect(r.map((e) => e.muted)).toEqual([false, false]);
    applyVoiceRules('deaf', null, r);
    expect(r.map((e) => e.muted)).toEqual([true, true]);
  });
});

describe('requestMic', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'mediaDevices', original);
    else delete (navigator as unknown as Record<string, unknown>).mediaDevices;
  });

  const setDevices = (value: unknown) =>
    Object.defineProperty(navigator, 'mediaDevices', { value, configurable: true, writable: true });

  it('returns the first audio track when granted, asking for audio only', async () => {
    const audio = { kind: 'audio' } as MediaStreamTrack;
    const getUserMedia = vi.fn().mockResolvedValue({ getAudioTracks: () => [audio] });
    setDevices({ getUserMedia });
    await expect(requestMic()).resolves.toBe(audio);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
  });

  it('returns null when permission is denied', async () => {
    const err = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const getUserMedia = vi.fn().mockRejectedValue(err);
    setDevices({ getUserMedia });
    await expect(requestMic()).resolves.toBeNull();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('returns null when navigator.mediaDevices is undefined (insecure context)', async () => {
    setDevices(undefined);
    await expect(requestMic()).resolves.toBeNull();
  });

  it('returns null when getUserMedia throws synchronously', async () => {
    setDevices({
      getUserMedia: () => {
        throw new TypeError('boom');
      },
    });
    await expect(requestMic()).resolves.toBeNull();
  });

  it('returns null when the stream has no audio track', async () => {
    setDevices({ getUserMedia: vi.fn().mockResolvedValue({ getAudioTracks: () => [] }) });
    await expect(requestMic()).resolves.toBeNull();
  });

  it('never requests video', async () => {
    const getUserMedia = vi.fn().mockResolvedValue({ getAudioTracks: () => [] });
    setDevices({ getUserMedia });
    await requestMic();
    for (const call of getUserMedia.mock.calls) {
      expect(call[0].video).toBe(false);
      expect(call[0].audio).toBe(true);
    }
  });
});

describe('VoiceGate', () => {
  it('rotation deaf -> blind unmutes the remotes again', () => {
    const g = new VoiceGate();
    const r = remotes(2);
    r.forEach((e) => g.addRemote(e));
    g.setRole('deaf');
    expect(r.map((e) => e.muted)).toEqual([true, true]);
    g.setRole('blind');
    expect(r.map((e) => e.muted)).toEqual([false, false]);
  });

  it('rotation mute -> blind re-enables the mic', () => {
    const g = new VoiceGate();
    const t = track();
    g.setLocalTrack(t);
    g.setRole('mute');
    expect(t.enabled).toBe(false);
    g.setRole('blind');
    expect(t.enabled).toBe(true);
  });

  it('rotation mute -> deaf re-enables the mic and mutes the remotes', () => {
    const g = new VoiceGate();
    const t = track();
    const r = remotes(2);
    g.setLocalTrack(t);
    r.forEach((e) => g.addRemote(e));
    g.setRole('mute');
    expect(t.enabled).toBe(false);
    expect(r.map((e) => e.muted)).toEqual([false, false]);
    g.setRole('deaf');
    expect(t.enabled).toBe(true);
    expect(r.map((e) => e.muted)).toEqual([true, true]);
  });

  it('role null restores everything', () => {
    const g = new VoiceGate();
    const t = track();
    const r = remotes(2);
    g.setLocalTrack(t);
    r.forEach((e) => g.addRemote(e));
    g.setRole('mute');
    g.setRole(null);
    expect(t.enabled).toBe(true);
    g.setRole('deaf');
    g.setRole(null);
    expect(r.map((e) => e.muted)).toEqual([false, false]);
  });

  it('a late-added remote for a deaf player is muted immediately', () => {
    const g = new VoiceGate();
    g.setRole('deaf');
    const late = { muted: false };
    g.addRemote(late);
    expect(late.muted).toBe(true);
  });

  it('a late remote for a non-deaf player stays unmuted', () => {
    const g = new VoiceGate();
    g.setRole('mute');
    const late = { muted: false };
    g.addRemote(late);
    expect(late.muted).toBe(false);
  });

  it('a late local track for the mute player is disabled immediately', () => {
    const g = new VoiceGate();
    g.setRole('mute');
    const t = track(true);
    g.setLocalTrack(t);
    expect(t.enabled).toBe(false);
  });

  it('a late local track for a non-mute player stays enabled', () => {
    const g = new VoiceGate();
    g.setRole('deaf');
    const t = track(true);
    g.setLocalTrack(t);
    expect(t.enabled).toBe(true);
  });

  it('a removed element is no longer touched by later setRole calls', () => {
    const g = new VoiceGate();
    const kept = { muted: false };
    const gone = { muted: false };
    g.addRemote(kept);
    g.addRemote(gone);
    g.setRole('deaf');
    g.removeRemote(gone);
    expect(gone.muted).toBe(true);
    g.setRole('blind');
    expect(kept.muted).toBe(false);
    expect(gone.muted).toBe(true);
    g.setRole('deaf');
    expect(gone.muted).toBe(true);
  });

  it('mic denied: mute works with a null track, deaf still mutes remotes', () => {
    const g = new VoiceGate();
    const r = remotes(2);
    r.forEach((e) => g.addRemote(e));
    g.setLocalTrack(null);
    expect(() => g.setRole('mute')).not.toThrow();
    expect(r.map((e) => e.muted)).toEqual([false, false]);
    g.setRole('deaf');
    expect(r.map((e) => e.muted)).toEqual([true, true]);
  });

  it('replacing the local track stops touching the old one', () => {
    const g = new VoiceGate();
    const a = track();
    const b = track();
    g.setLocalTrack(a);
    g.setRole('mute');
    g.setLocalTrack(b);
    expect(b.enabled).toBe(false);
    g.setRole('blind');
    expect(b.enabled).toBe(true);
    a.enabled = false;
    g.setRole('blind');
    expect(a.enabled).toBe(false);
  });
});
