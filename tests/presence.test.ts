import { describe, expect, test } from "bun:test";
import {
  createDomCrdtPresencePointAdapter,
  createPresenceStore,
  type Presence,
  type PresencePoint,
} from "../src/index.ts";
import { clonePeer, createPeer, destroyPeers } from "./helpers.ts";

describe("transport-agnostic presence state", () => {
  test("publishes monotonically sequenced local state and heartbeats", () => {
    const sent: Presence<string>[] = [];
    const store = createPresenceStore<string>({
      peerId: "local",
      name: "Local peer",
      color: "#123456",
      send: (presence) => sent.push(presence),
    });

    const first = store.updateLocal("anchor-1", "focus-1");
    const heartbeat = store.broadcastLocal();
    const second = store.updateLocal("anchor-2", "focus-2");

    expect(first.sequence).toBe(1);
    expect(heartbeat?.sequence).toBe(2);
    expect(second.sequence).toBe(3);
    expect(sent.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
    expect(store.getLocal()).toEqual(second);
    store.destroy();
  });

  test("ignores stale messages, expires inactive peers, and removes goodbye peers", () => {
    let now = 1_000;
    const store = createPresenceStore<string>({
      peerId: "local",
      name: "Local peer",
      color: "blue",
      send: () => {},
      expiryMs: 10_000,
      now: () => now,
    });
    const changes: string[] = [];
    store.subscribe((change) => changes.push(
      change.type === "update"
        ? `update:${change.presence.peerId}:${change.presence.sequence}`
        : `remove:${change.peerId}`,
    ));

    const remote = (sequence: number): Presence<string> => ({
      peerId: "remote",
      sequence,
      name: "Remote peer",
      color: "red",
      anchor: "a",
      focus: "f",
    });
    expect(store.receive(remote(2))).toBe(true);
    expect(store.receive(remote(1))).toBe(false);
    expect(store.getRemote("remote")?.sequence).toBe(2);

    now += 9_999;
    expect(store.prune()).toEqual([]);
    now += 1;
    expect(store.prune()).toEqual(["remote"]);
    expect(store.getRemote("remote")).toBeUndefined();
    expect(store.receive(remote(1))).toBe(false);

    expect(store.receive(remote(3))).toBe(true);
    expect(store.remove("remote")).toBe(true);
    expect(changes).toEqual([
      "update:remote:2",
      "remove:remote",
      "update:remote:3",
      "remove:remote",
    ]);
    store.destroy();
  });
});

describe("Loro DOM presence point adapter", () => {
  test("round-trips stable text cursors after intervening text edits", () => {
    const a = createPeer("<p>hello</p>");
    const b = clonePeer(a);
    try {
      const adapterA = createDomCrdtPresencePointAdapter(a.sync);
      const adapterB = createDomCrdtPresencePointAdapter(b.sync);
      const textA = a.root.querySelector("p")!.firstChild as Text;
      const point = adapterA.capture(textA, 2) as PresencePoint;
      expect(point.kind).toBe("text");

      const textB = b.root.querySelector("p")!.firstChild as Text;
      textB.data = `X${textB.data}`;
      b.sync.flush();
      const resolved = adapterB.resolve(point);

      expect(resolved?.node).toBe(textB);
      expect(resolved?.offset).toBe(3);
    } finally {
      destroyPeers(a, b);
    }
  });

  test("represents element endpoints as stable child boundaries", () => {
    const a = createPeer("<p>one</p><p>two</p>");
    const b = clonePeer(a);
    try {
      const adapterA = createDomCrdtPresencePointAdapter(a.sync);
      const adapterB = createDomCrdtPresencePointAdapter(b.sync);
      const point = adapterA.capture(a.root, 1) as PresencePoint;

      expect(point.kind).toBe("boundary");
      const resolved = adapterB.resolve(point);
      expect(resolved?.node).toBe(b.root);
      expect(resolved?.offset).toBe(1);
    } finally {
      destroyPeers(a, b);
    }
  });
});
