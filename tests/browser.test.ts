import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import demoPage from "../example/index.html";

async function eventually<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeout = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    value = await read();
  }
  return value;
}

async function waitForSpace(page: Page): Promise<void> {
  await page.locator("#crdt-tree").waitFor({ state: "attached" });
  const tree = await eventually(
    () => page.locator("#crdt-tree").textContent(),
    (value) => Boolean(value?.includes("root #") && value.includes("h1 #")),
  );
  expect(tree).toContain("h1 #");
}

describe("real browser multi-tab integration", () => {
  let server: ReturnType<typeof Bun.serve>;
  let browser: Browser;
  let context: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let pageC: Page | undefined;
  let spaceUrl: string;

  beforeAll(async () => {
    server = Bun.serve({ port: 0, routes: { "/spaces/:id": demoPage } });
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    spaceUrl = new URL(`/spaces/browser-${crypto.randomUUID()}`, server.url).href;
    pageA = await context.newPage();
    await pageA.goto(spaceUrl);
    await waitForSpace(pageA);
    pageB = await context.newPage();
    await pageB.goto(spaceUrl);
    await waitForSpace(pageB);

    const connected = await eventually(
      () => pageA.locator("#connection-status").textContent(),
      (value) => Boolean(value?.includes("1 other tab")),
    );
    expect(connected).toContain("1 other tab");
  }, 15_000);

  afterAll(async () => {
    await pageC?.close();
    await pageB?.close();
    await pageA?.close();
    await context?.close();
    await browser?.close();
    server?.stop(true);
  }, 15_000);

  test("ordinary DOM text and list creation stream to another tab", async () => {
    await pageA.evaluate(() => {
      const title = document.querySelector("#document-root h1")!.firstChild as Text;
      title.data = "A plan edited in tab A";
    });
    await pageA.locator("#add-item").click();

    const titleB = await eventually(
      () => pageB.locator("#document-root h1").textContent(),
      (value) => value === "A plan edited in tab A",
    );
    const countB = await eventually(
      () => pageB.locator("#task-list .task-item").count(),
      (value) => value === 4,
    );
    expect(titleB).toBe("A plan edited in tab A");
    expect(countB).toBe(4);

    const localEvents = await pageA.locator('#change-stream [data-kind="local"]').count();
    const remoteEvents = await eventually(
      () => pageB.locator('#change-stream [data-kind="remote"]').count(),
      (value) => value > 0,
    );
    expect(localEvents).toBeGreaterThan(0);
    expect(remoteEvents).toBeGreaterThan(0);
    expect(await pageA.locator("#last-update-size").textContent()).toMatch(
      /^Last update \d+\.\d{2} KB$/,
    );
    expect(
      await pageA.locator('#change-stream [data-kind="outgoing"] .change-size').first().textContent(),
    ).toMatch(/^\d+\.\d{2} KB$/);
    expect(
      await pageB.locator('#change-stream [data-kind="remote"] .change-size').first().textContent(),
    ).toMatch(/^\d+\.\d{2} KB$/);
  });

  test("a remote text edit preserves the focused peer's CRDT-relative caret", async () => {
    const selector = "#document-root .document-summary";
    const original = await pageA.locator(selector).textContent();
    expect(original).not.toBeNull();
    const caretBefore = 10;
    const insertion = "[remote] ";

    await pageB.locator(selector).evaluate((element, offset) => {
      const text = element.firstChild;
      if (!(text instanceof Text)) throw new Error("Expected a text node");
      (element as HTMLElement).focus();
      getSelection()?.setBaseAndExtent(text, offset, text, offset);
    }, caretBefore);

    await pageA.locator(selector).evaluate((element, prefix) => {
      const text = element.firstChild;
      if (!(text instanceof Text)) throw new Error("Expected a text node");
      text.data = prefix + text.data;
    }, insertion);

    const remoteSelection = await eventually(
      () => pageB.locator(selector).evaluate((element) => {
        const selection = getSelection();
        return {
          text: element.textContent,
          active: document.activeElement === element,
          inText: selection?.anchorNode === element.firstChild && selection.focusNode === element.firstChild,
          anchorOffset: selection?.anchorOffset,
          focusOffset: selection?.focusOffset,
        };
      }),
      (value) => value.text === insertion + original,
    );

    expect(remoteSelection.active).toBe(true);
    expect(remoteSelection.inText).toBe(true);
    expect(remoteSelection.anchorOffset).toBe(caretBefore + insertion.length);
    expect(remoteSelection.focusOffset).toBe(caretBefore + insertion.length);
  });

  test("a remote append does not extend a selection ending at the text boundary", async () => {
    const selector = "#document-root .notes p";
    const original = await pageA.locator(selector).textContent();
    expect(original).not.toBeNull();
    const selectedWord = "editing.";
    const selectionStart = original!.lastIndexOf(selectedWord);
    const selectionEnd = original!.length;
    const appended = " Added remotely.";
    expect(selectionStart).toBeGreaterThanOrEqual(0);

    await pageB.locator(selector).evaluate((element, offsets) => {
      const text = element.firstChild;
      if (!(text instanceof Text)) throw new Error("Expected a text node");
      (element as HTMLElement).focus();
      getSelection()?.setBaseAndExtent(text, offsets.start, text, offsets.end);
    }, { start: selectionStart, end: selectionEnd });

    await pageA.locator(selector).evaluate((element, suffix) => {
      const text = element.firstChild;
      if (!(text instanceof Text)) throw new Error("Expected a text node");
      text.data += suffix;
    }, appended);

    const remoteSelection = await eventually(
      () => pageB.locator(selector).evaluate((element) => {
        const selection = getSelection();
        return {
          text: element.textContent,
          selected: selection?.toString(),
          anchorOffset: selection?.anchorOffset,
          focusOffset: selection?.focusOffset,
        };
      }),
      (value) => value.text === original + appended,
    );

    expect(remoteSelection.selected).toBe(selectedWord);
    expect(remoteSelection.anchorOffset).toBe(selectionStart);
    expect(remoteSelection.focusOffset).toBe(selectionEnd);
  });

  test("renders a remote backward selection without mutating the synchronized root", async () => {
    const selector = "#document-root .document-summary";
    const text = await pageA.locator(selector).textContent();
    expect(text).not.toBeNull();
    const anchor = 18;
    const focus = 5;
    const crdtBefore = await pageB.locator("#crdt-json").textContent();

    await pageA.locator(selector).evaluate((element, offsets) => {
      const textNode = element.firstChild;
      if (!(textNode instanceof Text)) throw new Error("Expected a text node");
      (element as HTMLElement).focus();
      getSelection()?.setBaseAndExtent(textNode, offsets.anchor, textNode, offsets.focus);
    }, { anchor, focus });

    const rendered = await eventually(
      () => pageB.evaluate(() => {
        const caret = document.querySelector<HTMLElement>("#presence-layer .remote-caret");
        const highlightName = Array.from(CSS.highlights.keys()).find((name) =>
          name.startsWith("domsyn-peer-")
        );
        const highlight = highlightName ? CSS.highlights.get(highlightName) : undefined;
        const range = highlight ? Array.from(highlight)[0] as Range | undefined : undefined;
        return {
          caretVisible: Boolean(caret && !caret.hidden && caret.style.left && caret.style.height),
          caretInsideRoot: Boolean(caret?.closest("#document-root")),
          highlightedText: range?.toString(),
          rootCaretCount: document.querySelectorAll("#document-root .remote-caret").length,
        };
      }),
      (value) => value.caretVisible && value.highlightedText === text!.slice(focus, anchor),
    );

    expect(rendered.highlightedText).toBe(text!.slice(focus, anchor));
    expect(rendered.caretInsideRoot).toBe(false);
    expect(rendered.rootCaretCount).toBe(0);
    expect(await pageB.locator("#crdt-json").textContent()).toBe(crdtBefore);
  });

  test("a cross-tab reorder preserves the existing remote Node object", async () => {
    expect(await pageA.locator(".drag-handle").first().getAttribute("draggable")).toBeNull();
    expect(await pageA.locator(".drag-handle").first().textContent()).toBe("");
    const remoteNode = await pageB.locator("#task-list .task-item").first().elementHandle();
    expect(remoteNode).not.toBeNull();
    await remoteNode!.evaluate((node) => {
      (node as Element & { runtimeMarker?: { stable: boolean } }).runtimeMarker = { stable: true };
    });

    const handleBox = await pageA.locator(".drag-handle").first().boundingBox();
    const targetBox = await pageA.locator("#task-list .task-item").nth(1).boundingBox();
    expect(handleBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    await pageA.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
    await pageA.mouse.down();
    await pageA.mouse.move(
      targetBox!.x + targetBox!.width / 2,
      targetBox!.y + targetBox!.height - 3,
      { steps: 6 },
    );
    await pageA.mouse.up();

    const preserved = await eventually(
      () => remoteNode!.evaluate((node) => {
        const list = document.querySelector("#task-list")!;
        const after = list.children[1] as Element & { runtimeMarker?: { stable: boolean } };
        return after === node && after.runtimeMarker?.stable === true;
      }),
      Boolean,
    );
    expect(preserved).toBe(true);
  }, 10_000);

  test("a slow drag remains a move while another peer streams intermediate updates", async () => {
    const initialCount = await pageA.locator("#task-list .task-item").count();
    const labelsBefore = new Set(
      await pageA.locator("#task-list .task-label").allTextContents(),
    );
    const remoteNode = await pageB.locator("#task-list .task-item").first().elementHandle();
    expect(remoteNode).not.toBeNull();
    await remoteNode!.evaluate((node) => {
      (node as Element & { slowDragMarker?: { stable: boolean } }).slowDragMarker = { stable: true };
    });

    const handleBox = await pageA.locator(".drag-handle").first().boundingBox();
    const rowBoxes = await pageA.locator("#task-list .task-item").evaluateAll((rows) =>
      rows.map((row) => {
        const bounds = row.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      })
    );
    expect(handleBox).not.toBeNull();
    expect(rowBoxes).toHaveLength(initialCount);

    await pageA.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
    await pageA.mouse.down();
    for (const bounds of rowBoxes.slice(1)) {
      await pageA.mouse.move(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height - 3,
        { steps: 4 },
      );
      // Let MutationObserver commit and BroadcastChannel deliver each
      // intermediate reorder before continuing the same pointer gesture.
      await pageA.waitForTimeout(80);
      expect(await pageA.locator("#task-list .task-item").count()).toBe(initialCount);
      expect(await pageB.locator("#task-list .task-item").count()).toBe(initialCount);
    }
    await pageA.mouse.up();

    const preserved = await eventually(
      () => remoteNode!.evaluate((node) => {
        const last = document.querySelector("#task-list")!.lastElementChild as Element & {
          slowDragMarker?: { stable: boolean };
        };
        return last === node && last.slowDragMarker?.stable === true;
      }),
      Boolean,
    );
    const labelsA = new Set(await pageA.locator("#task-list .task-label").allTextContents());
    const labelsB = new Set(await pageB.locator("#task-list .task-label").allTextContents());
    expect(preserved).toBe(true);
    expect(labelsA).toEqual(labelsBefore);
    expect(labelsB).toEqual(labelsBefore);
  }, 15_000);

  test("a refreshed peer can drag without deleting the moved node", async () => {
    const initialCount = await pageB.locator("#task-list .task-item").count();
    const labelsBefore = new Set(
      await pageB.locator("#task-list .task-label").allTextContents(),
    );

    await pageB.reload();
    await waitForSpace(pageB);

    const convergedAfterRefresh = await eventually(
      async () => ({
        treeA: await pageA.locator("#crdt-tree").textContent(),
        treeB: await pageB.locator("#crdt-tree").textContent(),
        countB: await pageB.locator("#task-list .task-item").count(),
      }),
      ({ treeA, treeB, countB }) => treeA === treeB && countB === initialCount,
    );
    expect(convergedAfterRefresh.treeB).toBe(convergedAfterRefresh.treeA);

    const remoteNode = await pageA.locator("#task-list .task-item").first().elementHandle();
    expect(remoteNode).not.toBeNull();
    await remoteNode!.evaluate((node) => {
      (node as Element & { refreshDragMarker?: { stable: boolean } }).refreshDragMarker = {
        stable: true,
      };
    });

    const handleBox = await pageB.locator(".drag-handle").first().boundingBox();
    const targetBox = await pageB.locator("#task-list .task-item").nth(1).boundingBox();
    expect(handleBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    await pageB.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
    await pageB.mouse.down();
    await pageB.mouse.move(
      targetBox!.x + targetBox!.width / 2,
      targetBox!.y + targetBox!.height - 3,
      { steps: 6 },
    );
    await pageB.mouse.up();

    const preserved = await eventually(
      () => remoteNode!.evaluate((node) => {
        const after = document.querySelector("#task-list")!.children[1] as Element & {
          refreshDragMarker?: { stable: boolean };
        };
        return after === node && after.refreshDragMarker?.stable === true;
      }),
      Boolean,
    );
    const countA = await pageA.locator("#task-list .task-item").count();
    const countB = await pageB.locator("#task-list .task-item").count();
    const labelsA = new Set(await pageA.locator("#task-list .task-label").allTextContents());
    const labelsB = new Set(await pageB.locator("#task-list .task-label").allTextContents());
    expect(preserved).toBe(true);
    expect(countA).toBe(initialCount);
    expect(countB).toBe(initialCount);
    expect(labelsA).toEqual(labelsBefore);
    expect(labelsB).toEqual(labelsBefore);
  }, 15_000);

  test("a late tab on the same space hydrates and catches up", async () => {
    pageC = await context.newPage();
    await pageC.goto(spaceUrl);
    await waitForSpace(pageC);

    const title = await eventually(
      () => pageC!.locator("#document-root h1").textContent(),
      (value) => value === "A plan edited in tab A",
    );
    const count = await eventually(
      () => pageC!.locator("#task-list .task-item").count(),
      (value) => value === 4,
    );
    expect(title).toBe("A plan edited in tab A");
    expect(count).toBe(4);

    const trees = await Promise.all([
      pageA.locator("#crdt-tree").textContent(),
      pageB.locator("#crdt-tree").textContent(),
      pageC.locator("#crdt-tree").textContent(),
    ]);
    expect(new Set(trees).size).toBe(1);
  }, 10_000);
});
