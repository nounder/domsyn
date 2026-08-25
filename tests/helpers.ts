import { Window as HappyWindow } from "happy-dom";
import { createDomCrdt, LoroDoc, type DomCrdtSync } from "../src/index.ts";

export interface TestWindow {
  document: Document;
  HTMLElement: typeof HTMLElement;
  customElements: CustomElementRegistry;
  Event: typeof Event;
  close(): void;
}

export interface TestPeer {
  window: TestWindow;
  root: Element;
  sync: DomCrdtSync;
}

export function createPeer(markup = ""): TestPeer {
  const window = new HappyWindow() as unknown as TestWindow;
  const root = window.document.createElement("div");
  root.innerHTML = markup;
  window.document.body.append(root);
  return { window, root, sync: createDomCrdt({ root }) };
}

export function clonePeer(source: TestPeer): TestPeer {
  const window = new HappyWindow() as unknown as TestWindow;
  const root = window.document.createElement("div");
  window.document.body.append(root);
  const doc = LoroDoc.fromSnapshot(source.sync.getSnapshot());
  return { window, root, sync: createDomCrdt({ root, doc }) };
}

export function exchange(a: TestPeer, b: TestPeer): void {
  a.sync.flush();
  b.sync.flush();
  const updateA = a.sync.getUpdate();
  const updateB = b.sync.getUpdate();
  a.sync.applyUpdate(updateB);
  b.sync.applyUpdate(updateA);
}

export function connect(a: TestPeer, b: TestPeer): () => void {
  const unsubscribeA = a.sync.onUpdate((update) => b.sync.applyUpdate(update));
  const unsubscribeB = b.sync.onUpdate((update) => a.sync.applyUpdate(update));
  return () => {
    unsubscribeA();
    unsubscribeB();
  };
}

export function signature(node: Node): unknown {
  if (node.nodeType === 3) return { type: "text", text: (node as Text).data };
  if (node.nodeType !== 1) return undefined;
  const element = node as Element;
  return {
    type: "element",
    namespaceURI: element.namespaceURI,
    localName: element.localName,
    attributes: Array.from(element.attributes)
      .map((attribute) => ({
        namespaceURI: attribute.namespaceURI,
        name: attribute.name,
        value: attribute.value,
      }))
      .sort((a, b) => `${a.namespaceURI}:${a.name}`.localeCompare(`${b.namespaceURI}:${b.name}`)),
    children: Array.from(element.childNodes).flatMap((child) => {
      const value = signature(child);
      return value === undefined ? [] : [value];
    }),
  };
}

export function textList(root: Element): string[] {
  return Array.from(root.children).map((element) => element.textContent ?? "");
}

export function destroyPeers(...peers: TestPeer[]): void {
  for (const peer of peers) {
    peer.sync.destroy();
    peer.window.close();
  }
}
