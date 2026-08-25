import { afterEach, describe, expect, test } from "bun:test";
import { LoroText } from "loro-crdt";
import {
  clonePeer,
  createPeer,
  destroyPeers,
  exchange,
  signature,
  textList,
  type TestPeer,
} from "./helpers.ts";

describe("multi-peer convergence", () => {
  const peers: TestPeer[] = [];
  afterEach(() => destroyPeers(...peers.splice(0)));

  function offlinePair(markup: string) {
    const a = createPeer(markup);
    const b = clonePeer(a);
    peers.push(a, b);
    return { a, b };
  }

  function expectConverged(a: TestPeer, b: TestPeer) {
    expect(signature(a.root)).toEqual(signature(b.root));
    expect(a.sync.dumpTree()).toBe(b.sync.dumpTree());
  }

  test("merges concurrent text edits in different regions", () => {
    const { a, b } = offlinePair("<p>hello world</p>");
    (a.root.querySelector("p")!.firstChild as Text).data = "hello world!";
    (b.root.querySelector("p")!.firstChild as Text).data = "say hello world";

    exchange(a, b);

    expectConverged(a, b);
    expect(a.root.textContent).toBe("say hello world!");
  });

  test("converges concurrent sibling insertions", () => {
    const { a, b } = offlinePair("<span>A</span><span>C</span>");
    const nodeB = a.window.document.createElement("span");
    nodeB.append("B");
    a.root.insertBefore(nodeB, a.root.children[1]!);
    const nodeD = b.window.document.createElement("span");
    nodeD.append("D");
    b.root.insertBefore(nodeD, b.root.children[1]!);

    exchange(a, b);

    expectConverged(a, b);
    expect(new Set(textList(a.root))).toEqual(new Set(["A", "B", "C", "D"]));
  });

  test("preserves node identity and descendant edits across a concurrent move", () => {
    const { a, b } = offlinePair(
      '<section id="a"><p>hello</p></section><section id="b"></section>',
    );
    const paragraphA = a.root.querySelector("p")!;
    const paragraphId = a.sync.getCrdtNode(paragraphA)!;
    a.root.querySelector("#b")!.append(paragraphA);
    (b.root.querySelector("p")!.firstChild as Text).data = "hello world";

    exchange(a, b);

    expectConverged(a, b);
    expect(a.root.querySelector("#b")!.querySelector("p")?.textContent).toBe("hello world");
    expect(a.sync.getCrdtNode(a.root.querySelector("p")!)).toBe(paragraphId);
    expect(b.sync.getCrdtNode(b.root.querySelector("p")!)).toBe(paragraphId);
  });

  test("concurrent moves of the same node converge by Loro tree ordering", () => {
    const { a, b } = offlinePair(
      '<div id="origin"><p>node</p></div><div id="x"></div><div id="y"></div>',
    );
    const id = a.sync.getCrdtNode(a.root.querySelector("p")!)!;
    a.root.querySelector("#x")!.append(a.root.querySelector("p")!);
    b.root.querySelector("#y")!.append(b.root.querySelector("p")!);

    exchange(a, b);

    expectConverged(a, b);
    expect(["x", "y"]).toContain(a.root.querySelector("p")!.parentElement!.id);
    expect(a.sync.getCrdtNode(a.root.querySelector("p")!)).toBe(id);
  });

  test("a deleted subtree stays deleted after a concurrent descendant edit", () => {
    const { a, b } = offlinePair("<article><p>hello</p></article><aside>safe</aside>");
    const articleId = a.sync.getCrdtNode(a.root.querySelector("article")!)!;
    const textId = a.sync.getCrdtNode(a.root.querySelector("p")!.firstChild!)!;
    a.root.querySelector("article")!.remove();
    (b.root.querySelector("p")!.firstChild as Text).data = "hello world";

    exchange(a, b);

    expectConverged(a, b);
    expect(a.root.querySelector("article")).toBeNull();
    const tree = a.sync.doc.getTree("dom");
    expect(tree.getNodeByID(articleId)?.isDeleted()).toBe(true);
    const tombstonedText = tree.getNodeByID(textId)?.data.get("text");
    expect(tombstonedText).toBeInstanceOf(LoroText);
    expect((tombstonedText as LoroText).toString()).toBe("hello world");
  });

  test("concurrent reorders converge deterministically", () => {
    const { a, b } = offlinePair(
      "<span>A</span><span>B</span><span>C</span><span>D</span>",
    );
    a.root.insertBefore(a.root.children[3]!, a.root.children[0]!);
    b.root.insertBefore(b.root.children[0]!, b.root.children[3]!);

    exchange(a, b);

    expectConverged(a, b);
    expect(new Set(textList(a.root))).toEqual(new Set(["A", "B", "C", "D"]));
  });

  test("same-attribute conflicts use Loro map LWW and converge", () => {
    const { a, b } = offlinePair('<div data-mode="initial"></div>');
    a.root.firstElementChild!.setAttribute("data-mode", "alpha");
    b.root.firstElementChild!.setAttribute("data-mode", "beta");

    exchange(a, b);

    expectConverged(a, b);
    expect(["alpha", "beta"]).toContain(
      a.root.firstElementChild!.getAttribute("data-mode") ?? "",
    );
  });

  test("deeply nested moves retain every descendant identity", () => {
    const { a, b } = offlinePair(
      '<div id="a"><section><article><p>deep</p></article></section></div><div id="b"></div>',
    );
    const sectionA = a.root.querySelector("section")!;
    const ids = [sectionA, ...Array.from(sectionA.querySelectorAll("*"))].map((node) =>
      a.sync.getCrdtNode(node)
    );
    a.root.querySelector("#b")!.append(sectionA);
    a.sync.flush();
    b.sync.applyUpdate(a.sync.getUpdate());

    expectConverged(a, b);
    const sectionB = b.root.querySelector("section")!;
    const remoteIds = [sectionB, ...Array.from(sectionB.querySelectorAll("*"))].map((node) =>
      b.sync.getCrdtNode(node)
    );
    expect(remoteIds).toEqual(ids);
  });

  test("moving a child out while deleting its old parent preserves the child", () => {
    const { a, b } = offlinePair(
      '<div id="old"><p>survivor</p></div><div id="new"></div>',
    );
    const paragraph = a.root.querySelector("p")!;
    const id = a.sync.getCrdtNode(paragraph)!;
    a.root.querySelector("#new")!.append(paragraph);
    a.root.querySelector("#old")!.remove();
    a.sync.flush();
    b.sync.applyUpdate(a.sync.getUpdate());

    expect(b.root.querySelector("#new")!.querySelector("p")?.textContent).toBe("survivor");
    expect(b.sync.getCrdtNode(b.root.querySelector("p")!)).toBe(id);
  });
});
