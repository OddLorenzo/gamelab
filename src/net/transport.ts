import type { NetMsg, PeerId } from './protocol';

export interface Transport {
  id: PeerId;
  /** Ids of the other peers this transport can currently reach. */
  peers(): PeerId[];
  send(to: PeerId, msg: NetMsg): void;
  onMessage(cb: (from: PeerId, msg: NetMsg) => void): void;
  onPeerLeft(cb: (id: PeerId) => void): void;
}

/** A Transport backed by a Worker room: voice streams of the other peers plus teardown. */
export interface RoomConnection extends Transport {
  onRemoteAudio(cb: (id: PeerId, stream: MediaStream) => void): void;
  /**
   * The signaling socket closed on its own (not after `close()`): no new peer can join and the
   * room can no longer be told about leavers, but links that are open stay open. Optional in the
   * type so test doubles need not implement it; `RoomMesh` always does.
   */
  onSignalingClosed?(cb: (code: number, reason: string) => void): void;
  /**
   * A peer link never opened within 20 s, or failed before it opened (typically no TURN and no
   * direct path): it was torn down and is not retried. Fires once per peer id. Optional like
   * `onSignalingClosed`.
   */
  onLinkFailed?(cb: (id: PeerId) => void): void;
  close(): void;
}

/**
 * The host is the lowest PeerId in the room, this peer included. Only meaningful once all three
 * channels are open: with a partial peer list another guest could look like the lowest id.
 */
export function hostIdOf(t: Transport): PeerId {
  return [t.id, ...t.peers()].sort()[0];
}
