import { afterEach, describe, expect, test } from "bun:test";
import { LoroMap } from "loro-crdt";
import type { TreeID } from "../src/index.ts";
import {
  clonePeer,
  connect,
  createPeer,
  destroyPeers,
  signature,
  type TestPeer,
} from "./helpers.ts";

describe("DOM to CRDT translation", () => {
  const peers: TestPeer[] = [];
  afterEach(() => destroyPeers(...peers.splice(0)));

  function pair(markup = "") {
    const a = createPeer(markup);
    const b = clonePeer(a);
    peers.push(a, b);
    connect(a, b);
    return { a, b };
  }

  test("creates an element and text node", () => {
    const { a, b } = pair();
    const section = a.window.document.createElement("section");
    section.append(a.window.document.createTextNode("hello"));
    a.root.append(section);
    a.sync.flush();

    expect(signature(b.root)).toEqual(signature(a.root));
    expect(b.root.querySelector("section")?.textContent).toBe("hello");
    expect(a.sync.getCrdtNode(section)).toBe(
      b.sync.getCrdtNode(b.root.querySelector("section")!),
    );
    const sectionId = a.sync.getCrdtNode(section)!;
    const metadata = a.sync.doc.getTree("dom").getNodeByID(sectionId)!.data;
    expect(metadata.get("localName")).toBe("section");
    expect(metadata.get("tagName")).toBeUndefined();
  });

  test("imports a whole detached subtree recursively", () => {
    const { a, b } = pair();
    const article = a.window.document.createElement("article");
    const heading = a.window.document.createElement("h2");
    heading.append("Nested");
    const paragraph = a.window.document.createElement("p");
    paragraph.append("body");
    article.append(heading, paragraph);

    a.root.append(article);
    a.sync.flush();

    expect(signature(b.root)).toEqual(signature(a.root));
    expect(a.sync.getCrdtNode(paragraph)).toBe(
      b.sync.getCrdtNode(b.root.querySelector("p")!),
    );
  });

  test("removes and replaces nodes", () => {
    const { a, b } = pair("<p>old</p><aside>keep</aside>");
    const old = a.root.querySelector("p")!;
    const oldId = a.sync.getCrdtNode(old)!;
    const replacement = a.window.document.createElement("section");
    replacement.append("new");

    old.replaceWith(replacement);
    a.sync.flush();

    expect(b.root.querySelector("p")).toBeNull();
    expect(b.root.querySelector("section")?.textContent).toBe("new");
    expect(a.sync.getCrdtNode(replacement)).not.toBe(oldId);
    expect(a.sync.doc.getTree("dom").getNodeByID(oldId)?.isDeleted()).toBe(true);
  });

  test("adds, modifies, and removes attributes in one observer batch", () => {
    const { a, b } = pair("<div></div>");
    const element = a.root.firstElementChild!;
    element.setAttribute("data-state", "one");
    element.setAttribute("data-state", "two");
    element.setAttribute("title", "temporary");
    element.removeAttribute("title");
    a.sync.flush();

    const remote = b.root.firstElementChild!;
    expect(remote.getAttribute("data-state")).toBe("two");
    expect(remote.hasAttribute("title")).toBe(false);
    const elementId = a.sync.getCrdtNode(element)!;
    const attributes = a.sync.doc.getTree("dom").getNodeByID(elementId)?.data.get("attributes");
    expect(attributes).toBeInstanceOf(LoroMap);
    expect((attributes as LoroMap).get("data-state")).toBe("two");
    expect((attributes as LoroMap).get('[null,"data-state"]')).toBeUndefined();
  });

  test("translates text insertion, deletion, and replacement as CRDT text edits", () => {
    const { a, b } = pair("<p>abcdef</p>");
    const text = a.root.querySelector("p")!.firstChild as Text;

    text.data = "abcXYZdef";
    a.sync.flush();
    expect(b.root.textContent).toBe("abcXYZdef");

    text.data = "abcYZdef";
    a.sync.flush();
    expect(b.root.textContent).toBe("abcYZdef");

    text.data = "abc123def";
    a.sync.flush();
    expect(b.root.textContent).toBe("abc123def");
  });

  test("preserves SVG namespace and namespaced attributes", () => {
    const { a, b } = pair();
    const svg = a.window.document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = a.window.document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", "#shape");
    svg.append(use);
    a.root.append(svg);
    a.sync.flush();

    const remoteSvg = b.root.firstElementChild!;
    const remoteUse = remoteSvg.firstElementChild!;
    expect(remoteSvg.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(remoteUse.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(remoteUse.getAttributeNS("http://www.w3.org/1999/xlink", "href")).toBe("#shape");
  });

  test("treats custom elements as ordinary light-DOM elements", () => {
    const { a, b } = pair();
    class CarouselA extends a.window.HTMLElement {}
    class CarouselB extends b.window.HTMLElement {}
    a.window.customElements.define("my-carousel", CarouselA);
    b.window.customElements.define("my-carousel", CarouselB);

    const carousel = a.window.document.createElement("my-carousel");
    carousel.setAttribute("mode", "loop");
    carousel.append(
      a.window.document.createElement("img"),
      a.window.document.createElement("img"),
    );
    a.root.append(carousel);
    a.sync.flush();

    const remote = b.root.querySelector("my-carousel")!;
    expect(remote).toBeInstanceOf(CarouselB);
    expect(remote.children).toHaveLength(2);
    expect(remote.getAttribute("mode")).toBe("loop");
  });

  test("groups multiple synchronous DOM calls into one CRDT update", () => {
    const a = createPeer("<div><span>A</span></div>");
    peers.push(a);
    let updates = 0;
    a.sync.onUpdate(() => updates += 1);

    const div = a.root.firstElementChild!;
    const paragraph = a.window.document.createElement("p");
    paragraph.append("P");
    div.append(paragraph);
    div.setAttribute("class", "changed");
    (div.querySelector("span")!.firstChild as Text).data = "B";
    a.sync.flush();

    expect(updates).toBe(1);
  });

  test("ignores comments instead of assigning CRDT identity", () => {
    const { a, b } = pair("<p>text</p>");
    const comment = a.window.document.createComment("local only");
    a.root.prepend(comment);
    a.sync.flush();

    expect(a.sync.getCrdtNode(comment)).toBeUndefined();
    expect(Array.from(b.root.childNodes).some((node) => node.nodeType === 8)).toBe(false);
  });

  test("dumpTree exposes stable IDs without serializing HTML", () => {
    const a = createPeer('<div class="foo">hello</div>');
    peers.push(a);
    const divId = a.sync.getCrdtNode(a.root.firstElementChild!) as TreeID;
    const dump = a.sync.dumpTree();

    expect(dump).toContain(`div #${divId}`);
    expect(dump).toContain('@class="foo"');
    expect(dump).toContain('#text #');
  });
});
