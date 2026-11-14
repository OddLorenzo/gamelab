import type { NetMsg, PeerId } from '../../src/net/protocol';
import type { Transport } from '../../src/net/transport';

/**
 * In-memory network for tests. Delivery is SYNCHRONOUS: `send` runs the receiver's handlers
 * before returning, in send order. Every message goes through a JSON round trip (the wire
 * format of the real data channel), so peers never share object references, NaN becomes
 * null, and undefined fields vanish. Messages are NOT validated here: tests can send
 * malformed frames (cast to NetMsg) and see what the game code does with them.
 */
export interface MemoryNetwork extends Array<Transport> {
  /** Peer leaves: it stops sending/receiving and every other connected peer gets onPeerLeft. */
  disconnect(id: PeerId): void;
  /** Queue everything addressed to `id` instead of delivering it (a backgrounded tab). */
  hold(id: PeerId): void;
  /** Stop holding and deliver the queued messages in order. */
  flush(id: PeerId): void;
  /** Stop holding and DROP whatever was queued for `id` (frames lost before a channel opened). */
  discard(id: PeerId): void;
  /** Number of messages currently queued for `id`. */
  queued(id: PeerId): number;
}

interface Node {
  transport: Transport;
  connected: boolean;
  holding: boolean;
  queue: { from: PeerId; json: string }[];
  messageCbs: ((from: PeerId, msg: NetMsg) => void)[];
  leftCbs: ((id: PeerId) => void)[];
}

export function createMemoryNetwork(ids: PeerId[]): MemoryNetwork {
  const nodes = new Map<PeerId, Node>();

  const deliver = (to: Node, from: PeerId, json: string): void => {
    if (!to.connected) return;
    const msg = JSON.parse(json) as NetMsg;
    for (const cb of [...to.messageCbs]) cb(from, msg);
  };

  for (const id of ids) {
    const node: Node = {
      connected: true,
      holding: false,
      queue: [],
      messageCbs: [],
      leftCbs: [],
      transport: {
        id,
        peers: () => ids.filter((o) => o !== id && nodes.get(o)?.connected === true),
        send: (to, msg) => {
          const target = nodes.get(to);
          if (!node.connected || target === undefined || !target.connected) return;
          const json = JSON.stringify(msg);
          if (target.holding) target.queue.push({ from: id, json });
          else deliver(target, id, json);
        },
        onMessage: (cb) => {
          node.messageCbs.push(cb);
        },
        onPeerLeft: (cb) => {
          node.leftCbs.push(cb);
        },
      },
    };
    nodes.set(id, node);
  }

  const net = ids.map((id) => nodes.get(id)!.transport) as MemoryNetwork;
  net.disconnect = (id) => {
    const node = nodes.get(id);
    if (node === undefined || !node.connected) return;
    node.connected = false;
    node.queue = [];
    for (const other of nodes.values()) {
      if (other === node || !other.connected) continue;
      for (const cb of [...other.leftCbs]) cb(id);
    }
  };
  net.hold = (id) => {
    const node = nodes.get(id);
    if (node !== undefined) node.holding = true;
  };
  net.flush = (id) => {
    const node = nodes.get(id);
    if (node === undefined) return;
    node.holding = false;
    while (node.queue.length > 0) {
      const next = node.queue.shift()!;
      deliver(node, next.from, next.json);
    }
  };
  net.discard = (id) => {
    const node = nodes.get(id);
    if (node === undefined) return;
    node.holding = false;
    node.queue = [];
  };
  net.queued = (id) => nodes.get(id)?.queue.length ?? 0;
  return net;
}
