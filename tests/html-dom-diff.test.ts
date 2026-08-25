import { afterEach, describe, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { applyHtmlDomDiff, type HtmlDomDiffResult } from "../example/html-dom-diff.ts";
import { createDomCrdt } from "../src/index.ts";

interface Fixture {
  window: HappyWindow;
  root: Element;
}

const fixtures: Fixture[] = [];

function fixture(html: string): Fixture {
  const window = new HappyWindow();
  const root = window.document.createElement("div") as unknown as Element;
  root.innerHTML = html;
  window.document.body.append(root as never);
  const value = { window, root };
  fixtures.push(value);
  return value;
}

function expectNoStructureChanges(result: HtmlDomDiffResult): void {
  expect(result.created).toBe(0);
  expect(result.removed).toBe(0);
  expect(result.moved).toBe(0);
}

afterEach(() => {
  for (const { window } of fixtures.splice(0)) window.close();
});

describe("HTML to DOM diff", () => {
  test("does nothing for identical HTML", () => {
    const { root } = fixture('<article class="page"><h1>Title</h1><p>Body</p></article>');
    const article = root.firstChild;
    const heading = root.querySelector("h1");
    const result = applyHtmlDomDiff(
      root,
      '<article class="page"><h1>Title</h1><p>Body</p></article>',
    );

    expect(root.firstChild).toBe(article);
    expect(root.querySelector("h1")).toBe(heading);
    expect(result).toEqual({ created: 0, removed: 0, moved: 0, text: 0, attributes: 0 });
  });

  test("updates text and attributes without replacing nodes", () => {
    const { root } = fixture('<article class="old" data-remove="yes"><h1>Before</h1></article>');
    const article = root.firstElementChild!;
    const heading = root.querySelector("h1")!;
    const text = heading.firstChild!;

    const result = applyHtmlDomDiff(
      root,
      '<article class="new" title="kept"><h1>After</h1></article>',
    );

    expect(root.firstElementChild).toBe(article);
    expect(root.querySelector("h1")).toBe(heading);
    expect(heading.firstChild).toBe(text);
    expect(article.getAttribute("class")).toBe("new");
    expect(article.hasAttribute("data-remove")).toBe(false);
    expect(article.getAttribute("title")).toBe("kept");
    expect(text.nodeValue).toBe("After");
    expectNoStructureChanges(result);
    expect(result.text).toBe(1);
    expect(result.attributes).toBe(3);
  });

  test("inserts a same-tag sibling without repurposing following nodes", () => {
    const { root } = fixture("<p>A</p><p>C</p>");
    const first = root.children[0];
    const last = root.children[1];

    const result = applyHtmlDomDiff(root, "<p>A</p><p>B</p><p>C</p>");

    expect(root.children[0]).toBe(first);
    expect(root.children[2]).toBe(last);
    expect(Array.from(root.children, (element) => element.textContent)).toEqual(["A", "B", "C"]);
    expect(result.created).toBe(2);
    expect(result.removed).toBe(0);
  });

  test("removes a sibling while preserving the exact following node", () => {
    const { root } = fixture("<p>A</p><p>B</p>");
    const survivor = root.children[1]!;

    const result = applyHtmlDomDiff(root, "<p>B</p>");

    expect(root.firstElementChild).toBe(survivor);
    expect(result.created).toBe(0);
    expect(result.removed).toBe(2);
    expect(result.moved).toBe(1);
  });

  test("treats an edited first sibling as an edit rather than remove/create", () => {
    const { root } = fixture("<p>A</p><p>B</p>");
    const edited = root.children[0];
    const untouched = root.children[1];

    const result = applyHtmlDomDiff(root, "<p>X</p><p>B</p>");

    expect(root.children[0]).toBe(edited);
    expect(root.children[1]).toBe(untouched);
    expectNoStructureChanges(result);
    expect(result.text).toBe(1);
  });

  test("moves keyed list items and preserves runtime state", () => {
    const { root } = fixture(
      '<ul><li data-task="a">A</li><li data-task="b">B</li><li data-task="c">C</li></ul>',
    );
    const items = Object.fromEntries(
      Array.from(root.querySelectorAll("li"), (item) => [item.getAttribute("data-task"), item]),
    );
    (items.c as Element & { runtime?: object }).runtime = { preserved: true };

    const result = applyHtmlDomDiff(
      root,
      '<ul><li data-task="c">C</li><li data-task="a">A</li><li data-task="b">B</li></ul>',
    );

    expect(root.querySelectorAll("li")[0]).toBe(items.c);
    expect(root.querySelectorAll("li")[1]).toBe(items.a);
    expect(root.querySelectorAll("li")[2]).toBe(items.b);
    expect((items.c as Element & { runtime?: object }).runtime).toEqual({ preserved: true });
    expect(result.created).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.moved).toBe(1);
  });

  test("inserts a new keyed sibling without replacing existing keyed nodes", () => {
    const { root } = fixture('<div id="a">A</div><div id="b">B</div>');
    const a = root.children[0];
    const b = root.children[1];

    const result = applyHtmlDomDiff(
      root,
      '<div id="x">X</div><div id="a">A</div><div id="b">B</div>',
    );

    expect(root.children[1]).toBe(a);
    expect(root.children[2]).toBe(b);
    expect(result.created).toBe(2);
    expect(result.removed).toBe(0);
  });

  test("replaces an incompatible keyed element", () => {
    const { root } = fixture('<div id="target">content</div>');
    const previous = root.firstElementChild;

    const result = applyHtmlDomDiff(root, '<section id="target">content</section>');

    expect(root.firstElementChild).not.toBe(previous);
    expect(root.firstElementChild?.localName).toBe("section");
    expect(result.created).toBe(2);
    expect(result.removed).toBe(2);
  });

  test("updates a key attribute in place when it is not a sibling insertion", () => {
    const { root } = fixture('<article id="before"><p>Body</p></article>');
    const article = root.firstElementChild;
    const paragraph = root.querySelector("p");

    const result = applyHtmlDomDiff(root, '<article id="after"><p>Body</p></article>');

    expect(root.firstElementChild).toBe(article);
    expect(root.querySelector("p")).toBe(paragraph);
    expect(root.firstElementChild?.id).toBe("after");
    expectNoStructureChanges(result);
    expect(result.attributes).toBe(1);
  });

  test("moves distinct unkeyed element types instead of recreating them", () => {
    const { root } = fixture("<section>one</section><aside>two</aside>");
    const section = root.querySelector("section")!;
    const aside = root.querySelector("aside")!;

    const result = applyHtmlDomDiff(root, "<aside>two</aside><section>one</section>");

    expect(root.children[0]).toBe(aside);
    expect(root.children[1]).toBe(section);
    expect(result.created).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.moved).toBe(1);
  });

  test("creates only a genuinely new nested subtree", () => {
    const { root } = fixture("<main><h1>Title</h1></main>");
    const main = root.firstElementChild;
    const heading = root.querySelector("h1");

    const result = applyHtmlDomDiff(
      root,
      "<main><h1>Title</h1><section><p>New</p></section></main>",
    );

    expect(root.firstElementChild).toBe(main);
    expect(root.querySelector("h1")).toBe(heading);
    expect(result.created).toBe(3);
    expect(result.removed).toBe(0);
  });

  test("preserves pretty-print whitespace nodes around a text edit", () => {
    const before = `<article>
  <header>
    <h1>Before</h1>
  </header>
  <p>Body</p>
</article>
`;
    const after = before.replace("Before", "After");
    const { root } = fixture(before);
    const nodes = Array.from(root.querySelectorAll("*"));
    const whitespace = root.firstChild;

    const result = applyHtmlDomDiff(root, after);

    expect(Array.from(root.querySelectorAll("*"))).toEqual(nodes);
    expect(root.firstChild).toBe(whitespace);
    expectNoStructureChanges(result);
    expect(result.text).toBe(1);
  });

  test("can ignore block indentation without creating or moving CRDT nodes", () => {
    const { root } = fixture("<article><header><h1>Before</h1></header><p>Body</p></article>");
    const nodes = Array.from(root.querySelectorAll("*"));
    const result = applyHtmlDomDiff(
      root,
      `<article>
  <header>
    <h1>After</h1>
  </header>
  <p>Body</p>
</article>
`,
      { ignoreFormattingWhitespace: true },
    );

    expect(Array.from(root.querySelectorAll("*"))).toEqual(nodes);
    expect(root.querySelector("h1")?.textContent).toBe("After");
    expectNoStructureChanges(result);
    expect(result.text).toBe(1);
  });

  test("ignores formatter indentation around text in a multi-line opening tag", () => {
    const { root } = fixture('<h1 data-editable="title" contenteditable="true">Before</h1>');
    const heading = root.firstElementChild;
    const text = heading?.firstChild;

    const result = applyHtmlDomDiff(
      root,
      `<h1
  data-editable="title"
  contenteditable="true"
>
  After
</h1>
`,
      { ignoreFormattingWhitespace: true },
    );

    expect(root.firstElementChild).toBe(heading);
    expect(heading?.firstChild).toBe(text);
    expect(heading?.textContent).toBe("After");
    expectNoStructureChanges(result);
    expect(result.text).toBe(1);
  });

  test("collapses wrapped formatter lines but preserves whitespace-sensitive text", () => {
    const { root } = fixture("<p>One two three</p><pre>  exact\n  text</pre>");
    const result = applyHtmlDomDiff(
      root,
      `<p>
  One two
  three
</p>
<pre>  exact
  text</pre>
`,
      { ignoreFormattingWhitespace: true },
    );

    expect(root.querySelector("p")?.textContent).toBe("One two three");
    expect(root.querySelector("pre")?.textContent).toBe("  exact\n  text");
    expect(result).toEqual({ created: 0, removed: 0, moved: 0, text: 0, attributes: 0 });
  });

  test("does not discard a meaningful inline separating space", () => {
    const { root } = fixture("<p><span>Hello</span> <span>world</span></p>");
    const result = applyHtmlDomDiff(
      root,
      "<p><span>Hello</span> <span>world</span></p>",
      { ignoreFormattingWhitespace: true },
    );

    expect(root.querySelector("p")?.textContent).toBe("Hello world");
    expect(result).toEqual({ created: 0, removed: 0, moved: 0, text: 0, attributes: 0 });
  });

  test("updates comments in place", () => {
    const { root } = fixture("<!-- before --><p>Body</p>");
    const comment = root.firstChild;

    const result = applyHtmlDomDiff(root, "<!-- after --><p>Body</p>");

    expect(root.firstChild).toBe(comment);
    expect(comment?.nodeValue).toBe(" after ");
    expectNoStructureChanges(result);
    expect(result.text).toBe(1);
  });

  test("reuses SVG nodes and diffs namespaced attributes", () => {
    const { root } = fixture(
      '<svg viewBox="0 0 10 10"><use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#a"></use></svg>',
    );
    const svg = root.firstElementChild!;
    const use = root.querySelector("use")!;

    const result = applyHtmlDomDiff(
      root,
      '<svg viewBox="0 0 20 20"><use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#b"></use></svg>',
    );

    expect(root.firstElementChild).toBe(svg);
    expect(root.querySelector("use")).toBe(use);
    expect(svg.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(use.getAttributeNS("http://www.w3.org/1999/xlink", "href")).toBe("#b");
    expectNoStructureChanges(result);
    expect(result.attributes).toBe(2);
  });

  test("supports an application-defined key", () => {
    const { root } = fixture('<div slug="a">A</div><div slug="b">B</div>');
    const a = root.children[0];
    const b = root.children[1];

    const result = applyHtmlDomDiff(
      root,
      '<div slug="b">B</div><div slug="a">A</div>',
      { getKey: (element) => element.getAttribute("slug") ?? undefined },
    );

    expect(root.children[0]).toBe(b);
    expect(root.children[1]).toBe(a);
    expect(result.moved).toBe(1);
    expect(result.created).toBe(0);
    expect(result.removed).toBe(0);
  });

  test("produces a small text-only CRDT update with no tree actions", () => {
    const { root } = fixture('<article id="document"><h1>Before</h1><p>Body</p></article>');
    const sync = createDomCrdt({ root, origin: "origin" });
    const heading = root.querySelector("h1")!;
    const headingId = sync.getCrdtNode(heading);
    const updates: Uint8Array[] = [];
    const treeActions: string[] = [];
    const unsubscribeUpdate = sync.onUpdate((update) => updates.push(update));
    const unsubscribeDoc = sync.doc.subscribe((batch) => {
      if (batch.origin !== "origin") return;
      for (const event of batch.events) {
        if (event.diff.type === "tree") {
          treeActions.push(...event.diff.diff.map(({ action }) => action));
        }
      }
    });

    try {
      const result = applyHtmlDomDiff(
        root,
        '<article id="document"><h1>After</h1><p>Body</p></article>',
      );
      sync.flush();

      expectNoStructureChanges(result);
      expect(sync.getCrdtNode(root.querySelector("h1")!)).toBe(headingId);
      expect(treeActions).toEqual([]);
      expect(updates).toHaveLength(1);
      expect(updates[0]!.byteLength).toBeLessThan(1_000);
    } finally {
      unsubscribeDoc();
      unsubscribeUpdate();
      sync.destroy();
    }
  });
});
