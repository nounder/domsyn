export interface Presence<TPoint> {
  peerId: string;
  sequence: number;
  name: string;
  color: string;
  anchor: TPoint;
  focus: TPoint;
}

export type PresenceChange<TPoint> =
  | { type: "update"; presence: Presence<TPoint> }
  | { type: "remove"; peerId: string; presence: Presence<TPoint> };

export interface CreatePresenceStoreOptions<TPoint> {
  peerId: string;
  name: string;
  color: string;
  send: (presence: Presence<TPoint>) => void;
  heartbeatMs?: number;
  expiryMs?: number;
  now?: () => number;
}

export interface PresenceStore<TPoint> {
  readonly peerId: string;
  updateLocal(anchor: TPoint, focus: TPoint): Presence<TPoint>;
  clearLocal(): void;
  broadcastLocal(): Presence<TPoint> | undefined;
  receive(presence: Presence<TPoint>): boolean;
  remove(peerId: string): boolean;
  prune(now?: number): string[];
  getLocal(): Presence<TPoint> | undefined;
  getRemote(peerId: string): Presence<TPoint> | undefined;
  getRemotes(): Presence<TPoint>[];
  subscribe(listener: (change: PresenceChange<TPoint>) => void): () => void;
  destroy(): void;
}

interface RemotePresence<TPoint> {
  presence: Presence<TPoint>;
  lastSeen: number;
}

const DEFAULT_HEARTBEAT_MS = 3_000;
const DEFAULT_EXPIRY_MS = 10_000;

class PresenceStoreImpl<TPoint> implements PresenceStore<TPoint> {
  readonly peerId: string;

  private readonly name: string;
  private readonly color: string;
  private readonly send: (presence: Presence<TPoint>) => void;
  private readonly heartbeatMs: number;
  private readonly expiryMs: number;
  private readonly now: () => number;
  private readonly remotes = new Map<string, RemotePresence<TPoint>>();
  private readonly lastSequences = new Map<string, number>();
  private readonly listeners = new Set<(change: PresenceChange<TPoint>) => void>();
  private readonly timer: ReturnType<typeof setInterval>;
  private local: Presence<TPoint> | undefined;
  private sequence = 0;
  private lastBroadcastAt = 0;
  private destroyed = false;

  constructor(options: CreatePresenceStoreOptions<TPoint>) {
    if (!options.peerId) throw new Error("Presence peerId must not be empty");
    this.peerId = options.peerId;
    this.name = options.name;
    this.color = options.color;
    this.send = options.send;
    this.heartbeatMs = positiveDuration(options.heartbeatMs, DEFAULT_HEARTBEAT_MS);
    this.expiryMs = positiveDuration(options.expiryMs, DEFAULT_EXPIRY_MS);
    this.now = options.now ?? Date.now;

    const sweepMs = Math.max(100, Math.min(this.heartbeatMs, this.expiryMs / 5));
    this.timer = setInterval(() => this.tick(), sweepMs);
  }

  updateLocal(anchor: TPoint, focus: TPoint): Presence<TPoint> {
    this.assertActive();
    this.local = this.makeLocal(anchor, focus);
    this.broadcast(this.local);
    return this.local;
  }

  clearLocal(): void {
    this.local = undefined;
  }

  broadcastLocal(): Presence<TPoint> | undefined {
    this.assertActive();
    if (!this.local) return undefined;
    this.local = this.makeLocal(this.local.anchor, this.local.focus);
    this.broadcast(this.local);
    return this.local;
  }

  receive(presence: Presence<TPoint>): boolean {
    if (this.destroyed || !isValidPresence(presence) || presence.peerId === this.peerId) {
      return false;
    }

    const lastSequence = this.lastSequences.get(presence.peerId);
    if (lastSequence !== undefined && presence.sequence <= lastSequence) return false;

    this.lastSequences.set(presence.peerId, presence.sequence);
    this.remotes.set(presence.peerId, { presence, lastSeen: this.now() });
    this.emit({ type: "update", presence });
    return true;
  }

  remove(peerId: string): boolean {
    const remote = this.remotes.get(peerId);
    if (!remote) return false;
    this.remotes.delete(peerId);
    this.emit({ type: "remove", peerId, presence: remote.presence });
    return true;
  }

  prune(now = this.now()): string[] {
    const removed: string[] = [];
    for (const [peerId, remote] of this.remotes) {
      if (now - remote.lastSeen < this.expiryMs) continue;
      if (this.remove(peerId)) removed.push(peerId);
    }
    return removed;
  }

  getLocal(): Presence<TPoint> | undefined {
    return this.local;
  }

  getRemote(peerId: string): Presence<TPoint> | undefined {
    return this.remotes.get(peerId)?.presence;
  }

  getRemotes(): Presence<TPoint>[] {
    return Array.from(this.remotes.values(), ({ presence }) => presence);
  }

  subscribe(listener: (change: PresenceChange<TPoint>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.timer);
    this.local = undefined;
    this.remotes.clear();
    this.lastSequences.clear();
    this.listeners.clear();
  }

  private makeLocal(anchor: TPoint, focus: TPoint): Presence<TPoint> {
    return {
      peerId: this.peerId,
      sequence: ++this.sequence,
      name: this.name,
      color: this.color,
      anchor,
      focus,
    };
  }

  private broadcast(presence: Presence<TPoint>): void {
    this.lastBroadcastAt = this.now();
    this.send(presence);
  }

  private tick(): void {
    if (this.destroyed) return;
    const now = this.now();
    this.prune(now);
    if (this.local && now - this.lastBroadcastAt >= this.heartbeatMs) {
      this.broadcastLocal();
    }
  }

  private emit(change: PresenceChange<TPoint>): void {
    for (const listener of this.listeners) listener(change);
  }

  private assertActive(): void {
    if (this.destroyed) throw new Error("Cannot use a destroyed presence store");
  }
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isValidPresence<TPoint>(presence: Presence<TPoint>): boolean {
  return Boolean(
    presence &&
      typeof presence.peerId === "string" &&
      presence.peerId.length > 0 &&
      Number.isSafeInteger(presence.sequence) &&
      presence.sequence >= 0 &&
      typeof presence.name === "string" &&
      typeof presence.color === "string" &&
      presence.anchor !== undefined &&
      presence.focus !== undefined,
  );
}

export function createPresenceStore<TPoint>(
  options: CreatePresenceStoreOptions<TPoint>,
): PresenceStore<TPoint> {
  return new PresenceStoreImpl(options);
}
