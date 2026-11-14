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
  close(): void;
}

/**
 * The host is the lowest PeerId in the room, this peer included. Only meaningful once all three
 * channels are open: with a partial peer list another guest could look like the lowest id.
 */
export function hostIdOf(t: Transport): PeerId {
  return [t.id, ...t.peers()].sort()[0];
}
