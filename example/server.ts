import { watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, type ContextFormatter } from "@dprint/formatter";
import { Window as HappyWindow } from "happy-dom";
import page from "./index.html";
import { applyHtmlDomDiff } from "./html-dom-diff.ts";
import {
  createDomCrdt,
  type DomCrdtSync,
  type Presence,
  type PresencePoint,
} from "../src/index.ts";

const INTERNAL_PAGE_ROUTE = "/_domsyn/app";
const LORO_BROWSER_WASM = Bun.file(
  fileURLToPath(import.meta.resolve("loro-crdt/browser/loro_wasm_bg.wasm")),
);
const MARKUP_FORMATTER_WASM = Bun.file(
  fileURLToPath(import.meta.resolve("dprint-markup/plugin.wasm")),
);
const SPACE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,127})$/;
const ORIGIN = "origin";
let markupFormatterPromise: Promise<ContextFormatter> | undefined;

type ClientMessage = {
  kind: "presence";
  presence: Presence<PresencePoint>;
};

type ServerMessage =
  | { kind: "peers"; peers: string[] }
  | { kind: "peer-joined" | "peer-left"; peerId: string }
  | { kind: "presence"; sender: string; presence: Presence<PresencePoint> };

interface SocketData {
  actor: SpaceActor;
  peerId: string;
}

export interface SpaceServerOptions {
  port?: number;
  hostname?: string;
  spacesDirectory?: string;
  watchDebounceMs?: number;
  development?: boolean;
}

export interface SpaceServer {
  readonly server: Bun.Server<SocketData>;
  readonly spaces: SpaceRepository;
  stop(): Promise<void>;
}

function validSpaceId(id: string): boolean {
  return SPACE_ID_PATTERN.test(id);
}

function htmlResponse(body: string, status: number): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${status}</title></head><body><main><h1>${status}</h1><p>${body}</p></main></body></html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}

async function defaultSpaceHtml(): Promise<string> {
  const source = await Bun.file(new URL("./index.html", import.meta.url)).text();
  const window = new HappyWindow();
  try {
    window.document.documentElement.innerHTML = source;
    const root = window.document.querySelector("#space-root");
    if (!root) throw new Error("The demo page must contain #space-root");
    return formatSpaceHtml(root.innerHTML);
  } finally {
    window.close();
  }
}

async function formatSpaceHtml(html: string): Promise<string> {
  try {
    const formatter = await getMarkupFormatter();
    return formatter.formatText({
      filePath: "index.html",
      fileText: html,
    });
  } catch {
    // A partially-written file should still become a peer change. Happy DOM
    // can recover HTML that the formatter temporarily cannot parse.
    return html;
  }
}

function getMarkupFormatter(): Promise<ContextFormatter> {
  markupFormatterPromise ??= MARKUP_FORMATTER_WASM.arrayBuffer().then((plugin) => {
    const context = createContext({
      indentWidth: 2,
      lineWidth: 120,
      newLineKind: "lf",
      useTabs: false,
    });
    const formatter = context.addPlugin(plugin, {
      maxAttrsPerLine: 1,
      "component.selfClosing": true,
    });
    const diagnostics = formatter.getConfigDiagnostics();
    if (diagnostics.length > 0) {
      throw new Error(
        diagnostics.map(({ propertyName, message }) => `${propertyName}: ${message}`).join("\n"),
      );
    }
    return formatter;
  });
  return markupFormatterPromise;
}

class SpaceActor {
  readonly id: string;
  readonly sync: DomCrdtSync;

  private readonly path: string;
  private readonly window: HappyWindow;
  private readonly root: Element;
  private readonly sockets = new Set<Bun.ServerWebSocket<SocketData>>();
  private readonly unsubscribeUpdates: () => void;
  private readonly watcher: FSWatcher;
  private tail: Promise<void> = Promise.resolve();
  private reloadTimer?: ReturnType<typeof setTimeout>;
  private lastDiskHtml: string;
  private readingFilesystem = false;
  private persistQueued = false;
  private closed = false;

  private constructor(id: string, path: string, html: string, watchDebounceMs: number) {
    this.id = id;
    this.path = path;
    this.lastDiskHtml = html;
    this.window = new HappyWindow();
    const root = this.window.document.createElement("div");
    this.root = root as unknown as Element;
    this.root.setAttribute("id", "space-root");
    applyHtmlDomDiff(this.root, html, { ignoreFormattingWhitespace: true });
    this.window.document.body.append(root);
    this.sync = createDomCrdt({ root: this.root, origin: ORIGIN });
    this.unsubscribeUpdates = this.sync.onUpdate((update) => {
      this.broadcastBinary(update);
      if (!this.readingFilesystem) this.queuePersist();
    });
    this.watcher = watch(dirname(this.path), () => {
      // Editors commonly save by renaming a temporary sibling over index.html.
      // macOS may report only that temporary filename, so every event in this
      // actor-owned directory must trigger a debounced read of index.html.
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        this.reloadTimer = undefined;
        void this.reloadFromFilesystem().catch((error) => {
          console.error(`Could not reload space ${this.id}`, error);
        });
      }, watchDebounceMs);
    });
  }

  static async open(id: string, path: string, watchDebounceMs: number): Promise<SpaceActor> {
    const source = await Bun.file(path).text();
    const html = await formatSpaceHtml(source);
    if (html !== source) await Bun.write(path, html);
    return new SpaceActor(id, path, html, watchDebounceMs);
  }

  connect(socket: Bun.ServerWebSocket<SocketData>): void {
    if (this.closed) {
      socket.close(1012, "Space is unavailable");
      return;
    }

    const peers = Array.from(this.sockets, ({ data }) => data.peerId);
    socket.sendBinary(this.sync.getSnapshot());
    socket.sendText(JSON.stringify({ kind: "peers", peers } satisfies ServerMessage));
    this.broadcastJson({ kind: "peer-joined", peerId: socket.data.peerId }, socket);
    this.sockets.add(socket);
  }

  disconnect(socket: Bun.ServerWebSocket<SocketData>): void {
    if (!this.sockets.delete(socket)) return;
    this.broadcastJson({ kind: "peer-left", peerId: socket.data.peerId });
  }

  receive(socket: Bun.ServerWebSocket<SocketData>, message: string | Buffer): void {
    if (typeof message === "string") {
      this.receiveJson(socket, message);
      return;
    }

    const update = Uint8Array.from(message);
    void this.enqueue(async () => {
      this.sync.applyUpdate(update);
      this.broadcastBinary(update, socket);
      await this.persist();
    }).catch((error) => {
      console.error(`Rejected update for space ${this.id}`, error);
      socket.close(1003, "Invalid Loro update");
    });
  }

  async reloadFromFilesystem(): Promise<void> {
    await this.enqueue(async () => {
      if (!(await Bun.file(this.path).exists())) {
        this.closeSockets(1008, "Space was deleted");
        return;
      }

      const source = await Bun.file(this.path).text();
      const html = await formatSpaceHtml(source);
      if (html === this.lastDiskHtml) return;
      if (html !== source) await Bun.write(this.path, html);
      this.lastDiskHtml = html;
      if (html === this.root.innerHTML) return;

      this.readingFilesystem = true;
      try {
        applyHtmlDomDiff(this.root, html, { ignoreFormattingWhitespace: true });
        this.sync.flush();
      } finally {
        this.readingFilesystem = false;
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.watcher.close();
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    await this.tail.catch(() => {});
    this.closed = true;
    this.closeSockets(1012, "Server shutting down");
    this.unsubscribeUpdates();
    this.sync.destroy();
    this.window.close();
  }

  private receiveJson(socket: Bun.ServerWebSocket<SocketData>, encoded: string): void {
    let message: ClientMessage;
    try {
      message = JSON.parse(encoded) as ClientMessage;
    } catch {
      return;
    }

    if (
      message.kind !== "presence" ||
      typeof message.presence !== "object" ||
      message.presence === null ||
      message.presence.peerId !== socket.data.peerId
    ) return;

    this.broadcastJson({
      kind: "presence",
      sender: socket.data.peerId,
      presence: message.presence,
    }, socket);
  }

  private enqueue(operation: () => void | Promise<void>): Promise<void> {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch((error) => {
      console.error(`Space actor ${this.id} failed`, error);
    });
    return result;
  }

  private queuePersist(): void {
    if (this.persistQueued || this.closed) return;
    this.persistQueued = true;
    queueMicrotask(() => {
      this.persistQueued = false;
      void this.enqueue(() => this.persist());
    });
  }

  private async persist(): Promise<void> {
    const html = await formatSpaceHtml(this.root.innerHTML);
    if (html === this.lastDiskHtml) return;
    await Bun.write(this.path, html);
    this.lastDiskHtml = html;
  }

  private broadcastBinary(
    update: Uint8Array,
    except?: Bun.ServerWebSocket<SocketData>,
  ): void {
    for (const socket of this.sockets) {
      if (socket !== except) socket.sendBinary(update);
    }
  }

  private broadcastJson(
    message: ServerMessage,
    except?: Bun.ServerWebSocket<SocketData>,
  ): void {
    const encoded = JSON.stringify(message);
    for (const socket of this.sockets) {
      if (socket !== except) socket.sendText(encoded);
    }
  }

  private closeSockets(code: number, reason: string): void {
    for (const socket of this.sockets) socket.close(code, reason);
    this.sockets.clear();
  }
}

export class SpaceRepository {
  readonly directory: string;

  private readonly actors = new Map<string, Promise<SpaceActor>>();
  private readonly watchDebounceMs: number;

  constructor(directory: string, watchDebounceMs = 30) {
    this.directory = resolve(directory);
    this.watchDebounceMs = watchDebounceMs;
  }

  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  async create(): Promise<string> {
    const html = await defaultSpaceHtml();
    while (true) {
      const id = crypto.randomUUID();
      const path = this.path(id);
      if (await Bun.file(path).exists()) continue;
      await mkdir(dirname(path));
      await Bun.write(path, html);
      return id;
    }
  }

  async exists(id: string): Promise<boolean> {
    return validSpaceId(id) && await Bun.file(this.path(id)).exists();
  }

  async get(id: string): Promise<SpaceActor | undefined> {
    if (!(await this.exists(id))) return undefined;
    let actor = this.actors.get(id);
    if (!actor) {
      actor = SpaceActor.open(id, this.path(id), this.watchDebounceMs);
      this.actors.set(id, actor);
      actor.catch(() => this.actors.delete(id));
    }
    return actor;
  }

  async close(): Promise<void> {
    await Promise.all(Array.from(this.actors.values(), async (actor) => (await actor).close()));
    this.actors.clear();
  }

  private path(id: string): string {
    if (!validSpaceId(id)) throw new Error(`Invalid space id: ${id}`);
    return join(this.directory, id, "index.html");
  }
}

export async function createSpaceServer(options: SpaceServerOptions = {}): Promise<SpaceServer> {
  const spaces = new SpaceRepository(
    options.spacesDirectory ?? fileURLToPath(new URL("../data/spaces", import.meta.url)),
    options.watchDebounceMs,
  );
  await spaces.start();

  const server = Bun.serve<SocketData>({
    port: options.port ?? Number(Bun.env.PORT ?? 3000),
    hostname: options.hostname,
    routes: {
      "/": (request: Request) => Response.redirect(new URL("/spaces", request.url), 302),
      "/spaces": async (request: Request) => {
        const id = await spaces.create();
        return Response.redirect(new URL(`/spaces/${id}`, request.url), 302);
      },
      "/spaces/:id/ws": async (
        request: Bun.BunRequest<"/spaces/:id/ws">,
        server: Bun.Server<SocketData>,
      ) => {
        const actor = await spaces.get(request.params.id);
        if (!actor) return htmlResponse("Space not found.", 404);
        const peerId = new URL(request.url).searchParams.get("peer") ?? "";
        if (!validSpaceId(peerId)) return htmlResponse("Invalid peer id.", 400);
        if (!server.upgrade(request, { data: { actor, peerId } })) {
          return htmlResponse("Expected a WebSocket upgrade.", 426);
        }
      },
      "/spaces/:id": async (
        request: Bun.BunRequest<"/spaces/:id">,
        server: Bun.Server<SocketData>,
      ) => {
        if (!(await spaces.exists(request.params.id))) return htmlResponse("Space not found.", 404);
        return fetch(new URL(INTERNAL_PAGE_ROUTE, server.url));
      },
      "/loro_wasm_bg.wasm": LORO_BROWSER_WASM,
      [INTERNAL_PAGE_ROUTE]: page,
    },
    websocket: {
      open: (socket) => socket.data.actor.connect(socket),
      message: (socket, message) => socket.data.actor.receive(socket, message),
      close: (socket) => socket.data.actor.disconnect(socket),
    },
    development: options.development ?? { hmr: true, console: true },
    maxRequestBodySize: 1024 * 1024,
  });

  return {
    server,
    spaces,
    async stop() {
      server.stop(true);
      await spaces.close();
    },
  };
}

if (import.meta.main) {
  const app = await createSpaceServer();
  console.log(`DOM CRDT demo: ${app.server.url}`);
}
