import { afterEach, describe, expect, test } from "bun:test";
import {
  clonePeer,
  connect,
  createPeer,
  destroyPeers,
  signature,
  type TestPeer,
} from "./helpers.ts";

describe("CRDT to DOM projection", () => {
  const peers: TestPeer[] = [];
  afterEach(() => destroyPeers(...peers.splice(0)));

  test("hydrates an empty supplied root from an existing Loro document", () => {
    const a = createPeer("<main><h1>Hello</h1><p>body</p></main>");
    const b = clonePeer(a);
    peers.push(a, b);

    expect(signature(b.root)).toEqual(signature(a.root));
    expect(b.sync.dumpTree()).toBe(a.sync.dumpTree());
  });

  test("hydrates and migrates snapshots that used the legacy tagName key", () => {
    const a = createPeer("<section>legacy</section>");
    peers.push(a);
    const section = a.root.querySelector("section")!;
    const sectionId = a.sync.getCrdtNode(section)!;
    const metadata = a.sync.doc.getTree("dom").getNodeByID(sectionId)!.data;
    metadata.set("tagName", metadata.get("localName")!);
    metadata.delete("localName");
    a.sync.doc.commit();

    const b = clonePeer(a);
    peers.push(b);
    const migratedSection = b.root.querySelector("section")!;
    const migratedId = b.sync.getCrdtNode(migratedSection)!;
    const migratedMetadata = b.sync.doc.getTree("dom").getNodeByID(migratedId)!.data;

    expect(migratedSection.textContent).toBe("legacy");
    expect(migratedMetadata.get("localName")).toBe("section");
    expect(migratedMetadata.get("tagName")).toBeUndefined();
  });

  test("moves the existing remote DOM instance instead of recreating it", () => {
    const a = createPeer('<section id="a"><p>hello</p></section><section id="b"></section>');
    const b = clonePeer(a);
    peers.push(a, b);
    connect(a, b);

    const localParagraph = a.root.querySelector("p")!;
    const remoteParagraph = b.root.querySelector("p")!;
    const id = a.sync.getCrdtNode(localParagraph)!;
    let listenerCalls = 0;
    remoteParagraph.addEventListener("identity-check", () => listenerCalls += 1);

    a.root.querySelector("#b")!.append(localParagraph);
    a.sync.flush();

    expect(b.root.querySelector("p")).toBe(remoteParagraph);
    expect(b.root.querySelector("#b")!.firstElementChild).toBe(remoteParagraph);
    expect(b.sync.getCrdtNode(remoteParagraph)).toBe(id);
    remoteParagraph.dispatchEvent(new b.window.Event("identity-check"));
    expect(listenerCalls).toBe(1);
  });

  test("incrementally updates attributes and text without replacing the element", () => {
    const a = createPeer('<button class="before">press</button>');
    const b = clonePeer(a);
    peers.push(a, b);
    connect(a, b);

    const remoteButton = b.root.querySelector("button")!;
    const localButton = a.root.querySelector("button")!;
    localButton.setAttribute("class", "after");
    (localButton.firstChild as Text).data = "updated";
    a.sync.flush();

    expect(b.root.querySelector("button")).toBe(remoteButton);
    expect(remoteButton.className).toBe("after");
    expect(remoteButton.textContent).toBe("updated");
  });

  test("does not feed remote DOM mutations back into local CRDT updates", () => {
    const a = createPeer("<p>hello</p>");
    const b = clonePeer(a);
    peers.push(a, b);
    let updatesA = 0;
    let updatesB = 0;
    a.sync.onUpdate(() => updatesA += 1);
    b.sync.onUpdate(() => updatesB += 1);
    connect(a, b);

    (a.root.querySelector("p")!.firstChild as Text).data = "hello remote";
    a.sync.flush();
    b.sync.flush();

    expect(b.root.textContent).toBe("hello remote");
    expect(updatesA).toBe(1);
    expect(updatesB).toBe(0);
  });

  test("preserves custom-element instance state across a remote move", () => {
    const a = createPeer('<div id="left"><state-box></state-box></div><div id="right"></div>');
    const b = clonePeer(a);
    peers.push(a, b);
    connect(a, b);

    const remote = b.root.querySelector("state-box") as Element & { runtimeState?: object };
    const runtimeState = { retained: true };
    remote.runtimeState = runtimeState;

    a.root.querySelector("#right")!.append(a.root.querySelector("state-box")!);
    a.sync.flush();

    const after = b.root.querySelector("state-box") as Element & { runtimeState?: object };
    expect(after).toBe(remote);
    expect(after.runtimeState).toBe(runtimeState);
  });
});
