import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window as HappyWindow } from "happy-dom";
import { createSpaceServer, type SpaceServer } from "../example/server.ts";
import { createDomCrdt, LoroDoc } from "../src/index.ts";

async function eventually<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeout = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!predicate(value) && Date.now() < deadline) {
    await Bun.sleep(20);
    value = await read();
  }
  return value;
}

async function createSpace(app: SpaceServer): Promise<{ id: string; url: URL }> {
  const response = await fetch(new URL("/spaces", app.server.url), { redirect: "manual" });
  expect(response.status).toBe(302);
  const location = response.headers.get("location");
  if (!location) throw new Error("Missing space redirect");
  const url = new URL(location, app.server.url);
  return { id: url.pathname.split("/").at(-1)!, url };
}

function nextBinary(socket: WebSocket, timeout = 5_000): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(new Error("Timed out waiting for binary data"))), timeout);
    const finish = (done: () => void) => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      done();
    };
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data === "string") return;
      if (event.data instanceof ArrayBuffer) {
        finish(() => resolve(new Uint8Array(event.data)));
      } else if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((buffer) => finish(() => resolve(new Uint8Array(buffer))));
      }
    };
    const onClose = () => finish(() => reject(new Error("WebSocket closed")));
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
  });
}

describe("single-process space server", () => {
  test("creates plain HTML spaces and returns 404 for missing spaces", async () => {
    const directory = await mkdtemp(join(tmpdir(), "domsyn-server-"));
    const app = await createSpaceServer({ port: 0, spacesDirectory: directory, development: false });
    try {
      const { id, url } = await createSpace(app);
      const html = await Bun.file(join(directory, id, "index.html")).text();
      expect(html).toContain('<article\n  id="document-root"\n  class="document-page">');
      expect(html).toContain("Quarterly launch plan");
      expect(html).toContain("\n  <header");
      expect(html.endsWith("\n")).toBe(true);
      expect((await fetch(url)).status).toBe(200);

      const missing = await fetch(new URL("/spaces/does-not-exist", app.server.url));
      expect(missing.status).toBe(404);
      expect(missing.headers.get("content-type")).toContain("text/html");
      expect(await missing.text()).toContain("Space not found");
    } finally {
      await app.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("persists WebSocket updates and streams file edits from origin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "domsyn-server-"));
    const app = await createSpaceServer({
      port: 0,
      spacesDirectory: directory,
      watchDebounceMs: 5,
      development: false,
    });
    let socket: WebSocket | undefined;
    const window = new HappyWindow();
    try {
      const { id, url } = await createSpace(app);
      const socketUrl = new URL(`${url.pathname}/ws`, url);
      socketUrl.protocol = "ws:";
      socketUrl.searchParams.set("peer", "test-peer");
      socket = new WebSocket(socketUrl);
      socket.binaryType = "arraybuffer";
      const snapshot = await nextBinary(socket);

      const root = window.document.createElement("div") as unknown as Element;
      window.document.body.append(root as never);
      const client = createDomCrdt({ root, doc: LoroDoc.fromSnapshot(snapshot) });
      try {
        const unsubscribe = client.onUpdate((update) => {
          const payload = new ArrayBuffer(update.byteLength);
          new Uint8Array(payload).set(update);
          socket!.send(payload);
        });
        const title = root.querySelector("h1")!.firstChild as Text;
        title.data = "Changed through WebSocket";
        client.flush();

        const path = join(directory, id, "index.html");
        const persisted = await eventually(
          () => Bun.file(path).text(),
          (html) => html.includes("Changed through WebSocket"),
        );
        expect(persisted).toContain("Changed through WebSocket");

        const actor = await app.spaces.get(id);
        const origins: Array<string | undefined> = [];
        const unsubscribeActor = actor!.sync.doc.subscribe((batch) => origins.push(batch.origin));
        const incoming = nextBinary(socket);
        await Bun.write(path, persisted.replace("Changed through WebSocket", "Changed on disk"));
        client.applyUpdate(await incoming);

        expect(root.querySelector("h1")?.textContent).toBe("Changed on disk");
        expect(origins).toContain("origin");
        unsubscribeActor();
        unsubscribe();
      } finally {
        client.destroy();
      }
    } finally {
      socket?.close();
      window.close();
      await app.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
