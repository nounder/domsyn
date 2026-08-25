import {
  createDomCrdt,
  createDomCrdtPresencePointAdapter,
  createDomPresence,
  createPresenceStore,
  LoroDoc,
  type Presence,
  type PresencePoint,
} from "../src/index.ts";
import type { LoroEvent, LoroEventBatch } from "loro-crdt";

type ServerMessage =
  | { kind: "peers"; peers: string[] }
  | { kind: "peer-joined" | "peer-left"; peerId: string }
  | { kind: "presence"; sender: string; presence: Presence<PresencePoint> };

const root = requiredElement<HTMLElement>("#space-root");
const spaceId = decodeURIComponent(location.pathname.split("/").filter(Boolean).at(-1) ?? "local");
const tabId = crypto.randomUUID();
const socketUrl = new URL(`/spaces/${encodeURIComponent(spaceId)}/ws`, location.href);
socketUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
socketUrl.searchParams.set("peer", tabId);
const socket = new WebSocket(socketUrl);
socket.binaryType = "arraybuffer";
const initialSnapshot = await receiveInitialSnapshot(socket);
const sync = createDomCrdt({
  root,
  doc: LoroDoc.fromSnapshot(initialSnapshot),
});
const presenceLayer = requiredElement<HTMLElement>("#presence-layer");
const presenceStore = createPresenceStore<PresencePoint>({
  peerId: tabId,
  name: `Peer ${shortId(tabId)}`,
  color: peerColor(tabId),
  send: (presence) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(wireStringify({ kind: "presence", presence }));
    }
  },
});
const presence = createDomPresence({
  root,
  layer: presenceLayer,
  store: presenceStore,
  pointAdapter: createDomCrdtPresencePointAdapter(sync),
  beforeCapture: () => sync.flush(),
});
// Hydration preserves the supplied root but materializes its CRDT descendants.
// Resolve descendant references only after it has finished so UI actions never
// operate on elements from the discarded server-rendered subtree.
const list = requiredElement<HTMLUListElement>("#task-list");
const peers = new Set<string>();
let eventCount = 0;
let draggedItem: HTMLElement | undefined;
let draggedHandle: HTMLElement | undefined;
let dragPointerId: number | undefined;
let dragAnimation: Animation | undefined;
let importingUpdateBytes: number | undefined;

normalizeDragHandles();
sync.flush();

const unsubscribeUpdates = sync.onUpdate((update) => {
  const payload = new ArrayBuffer(update.byteLength);
  new Uint8Array(payload).set(update);
  socket.send(payload);
  appendEvent("outgoing", `Sent ${formatBytes(update.byteLength)} update`, {
    bytes: update.byteLength,
  }, update.byteLength);
});

const unsubscribeDoc = sync.doc.subscribe((batch) => {
  appendCrdtBatch(batch, batch.by === "import" ? importingUpdateBytes : undefined);
  queueMicrotask(renderState);
});

socket.addEventListener("message", async (event) => {
  if (typeof event.data !== "string") {
    const update = await messageBytes(event.data);
    appendEvent("incoming", `Received ${formatBytes(update.byteLength)} update`, {
      bytes: update.byteLength,
      sender: "server",
    }, update.byteLength);
    importingUpdateBytes = update.byteLength;
    try {
      sync.applyUpdate(update);
    } finally {
      importingUpdateBytes = undefined;
    }
    presence.refresh();
    renderConnection();
    return;
  }

  let message: ServerMessage;
  try {
    message = wireParse<ServerMessage>(event.data);
  } catch {
    return;
  }

  if (message.kind === "peers") {
    peers.clear();
    for (const peerId of message.peers) peers.add(peerId);
  } else if (message.kind === "peer-joined") {
    peers.add(message.peerId);
    presenceStore.broadcastLocal();
  } else if (message.kind === "peer-left") {
    peers.delete(message.peerId);
    presenceStore.remove(message.peerId);
  } else if (message.kind === "presence" && message.presence.peerId === message.sender) {
    peers.add(message.sender);
    presenceStore.receive(message.presence);
  }

  renderConnection();
});

socket.addEventListener("close", () => {
  peers.clear();
  renderConnection();
});

requiredElement<HTMLButtonElement>("#add-item").addEventListener("click", () => {
  const item = document.createElement("li");
  item.className = "task-item";
  item.dataset.task = crypto.randomUUID();

  const handle = document.createElement("button");
  handle.className = "drag-handle";
  handle.type = "button";
  handle.tabIndex = -1;
  handle.setAttribute("aria-label", "Drag new list item");

  const label = document.createElement("span");
  label.className = "task-label";
  label.contentEditable = "true";
  label.append(document.createTextNode("Untitled priority"));

  const remove = document.createElement("button");
  remove.className = "delete-item";
  remove.type = "button";
  remove.setAttribute("aria-label", "Remove new list item");
  remove.append(document.createTextNode("×"));

  item.append(handle, label, remove);
  list.appendChild(item);
  sync.flush();
  label.focus();
});

root.addEventListener("click", (event) => {
  const remove = (event.target as Element).closest<HTMLButtonElement>(".delete-item");
  if (!remove) return;
  remove.closest(".task-item")?.remove();
  sync.flush();
});

root.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const handle = (event.target as Element).closest<HTMLElement>(".drag-handle");
  const item = handle?.closest<HTMLElement>(".task-item");
  if (!handle || !item) return;
  event.preventDefault();
  draggedItem = item;
  draggedHandle = handle;
  dragPointerId = event.pointerId;
  handle.setPointerCapture(event.pointerId);
  document.body.classList.add("is-reordering");
  dragAnimation = item.animate(
    { opacity: 0.45, transform: "scale(0.995)" },
    { duration: 100, fill: "forwards" },
  );
});

root.addEventListener("pointermove", (event) => {
  if (!draggedItem || event.pointerId !== dragPointerId) return;
  event.preventDefault();
  const siblings = Array.from(list.children).filter(
    (child): child is HTMLElement => child !== draggedItem && child instanceof HTMLElement,
  );
  const nextSibling = siblings.find((sibling) => {
    const bounds = sibling.getBoundingClientRect();
    return event.clientY < bounds.top + bounds.height / 2;
  });
  list.insertBefore(draggedItem, nextSibling ?? null);
});

const finishPointerDrag = (event: PointerEvent) => {
  if (!draggedItem || event.pointerId !== dragPointerId) return;
  dragAnimation?.cancel();
  dragAnimation = undefined;
  if (draggedHandle?.hasPointerCapture(event.pointerId)) {
    draggedHandle.releasePointerCapture(event.pointerId);
  }
  document.body.classList.remove("is-reordering");
  draggedItem = undefined;
  draggedHandle = undefined;
  dragPointerId = undefined;
  sync.flush();
};

root.addEventListener("pointerup", finishPointerDrag);
root.addEventListener("pointercancel", finishPointerDrag);

root.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  if (target.dataset.editable === "title" && event.key === "Enter") event.preventDefault();
});

requiredElement<HTMLButtonElement>("#clear-events").addEventListener("click", () => {
  requiredElement<HTMLOListElement>("#change-stream").replaceChildren();
  eventCount = 0;
  renderEventCount();
});

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing space element: ${selector}`);
  return element;
}

function normalizeDragHandles(): void {
  for (const handle of root.querySelectorAll<HTMLButtonElement>(".drag-handle")) {
    handle.removeAttribute("draggable");
    handle.replaceChildren();
  }
}

function appendCrdtBatch(batch: LoroEventBatch, bytes?: number): void {
  const summary = batch.events.map(summarizeEvent).join(" · ") || "transaction committed";
  appendEvent(batch.by === "import" ? "remote" : "local", summary, {
    encodedBytes: bytes,
    by: batch.by,
    origin: batch.origin,
    from: batch.from,
    to: batch.to,
    events: batch.events.map((event) => ({
      target: event.target,
      path: event.path,
      diff: event.diff,
    })),
  }, bytes);
}

function summarizeEvent(event: LoroEvent): string {
  switch (event.diff.type) {
    case "tree":
      return event.diff.diff.map((item) => `${item.action} #${shortId(item.target)}`).join(", ");
    case "text": {
      const insertions = event.diff.diff.filter((delta) => "insert" in delta).length;
      const deletions = event.diff.diff.filter((delta) => "delete" in delta).length;
      return `text Δ +${insertions}/−${deletions}`;
    }
    case "map":
      return `map ${Object.keys(event.diff.updated).join(", ")}`;
    case "list":
      return `list Δ ${event.diff.diff.length}`;
    case "counter":
      return `counter ${event.diff.increment >= 0 ? "+" : ""}${event.diff.increment}`;
  }
}

function appendEvent(
  kind: "local" | "remote" | "incoming" | "outgoing" | "system",
  summary: string,
  detail?: unknown,
  bytes?: number,
): void {
  eventCount += 1;
  const item = document.createElement("li");
  item.className = "change-event";
  item.dataset.kind = kind;

  const heading = document.createElement("div");
  heading.className = "change-heading";
  const badge = document.createElement("span");
  badge.className = "change-badge";
  badge.textContent = kind;
  const time = document.createElement("time");
  time.dateTime = new Date().toISOString();
  time.textContent = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
  heading.append(badge);
  if (bytes !== undefined) {
    const size = document.createElement("span");
    size.className = "change-size";
    size.textContent = formatBytes(bytes);
    size.title = `${bytes} encoded bytes`;
    heading.append(size);
    requiredElement<HTMLElement>("#last-update-size").textContent = `Last update ${formatBytes(bytes)}`;
  }
  heading.append(time);

  const text = document.createElement("p");
  text.textContent = summary;
  item.append(heading, text);

  if (detail !== undefined) {
    const disclosure = document.createElement("details");
    const label = document.createElement("summary");
    label.textContent = "payload";
    const payload = document.createElement("pre");
    payload.textContent = safeStringify(detail);
    disclosure.append(label, payload);
    item.append(disclosure);
  }

  requiredElement<HTMLOListElement>("#change-stream").prepend(item);
  renderEventCount();
}

function renderState(): void {
  const dump = sync.dumpTree();
  requiredElement<HTMLElement>("#crdt-tree").textContent = dump;
  requiredElement<HTMLElement>("#crdt-json").textContent = safeStringify(sync.doc.toJSON());
  const nodes = Math.max(0, sync.doc.getTree("dom").getNodes().filter((node) => !node.isDeleted()).length - 1);
  requiredElement<HTMLElement>("#node-count").textContent = `${nodes} node${nodes === 1 ? "" : "s"}`;
  requiredElement<HTMLElement>("#space-id").textContent = `space ${shortId(spaceId)}`;
  requiredElement<HTMLElement>("#peer-id").textContent = `peer ${shortId(sync.doc.peerIdStr)}`;
  renderConnection();
}

function renderConnection(): void {
  const output = requiredElement<HTMLOutputElement>("#connection-status");
  if (socket.readyState !== WebSocket.OPEN) {
    output.value = socket.readyState === WebSocket.CONNECTING ? "Connecting" : "Disconnected";
    return;
  }
  const count = peers.size;
  output.value = count === 0
    ? "Live · waiting for another tab"
    : `Live · ${count} other tab${count === 1 ? "" : "s"}`;
}

function renderEventCount(): void {
  requiredElement<HTMLElement>("#event-count").textContent = `${eventCount} event${eventCount === 1 ? "" : "s"}`;
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1_024).toFixed(2)} KB`;
}

function peerColor(peerId: string): string {
  const palette = ["#d14f64", "#3d7dd8", "#39966f", "#9a62d4", "#cf762f", "#267f91"];
  let hash = 0;
  for (const character of peerId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length] ?? palette[0]!;
}

function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function wireStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item instanceof Uint8Array ? { __domsynBytes: Array.from(item) } : item
  );
}

function wireParse<T>(encoded: string): T {
  return JSON.parse(encoded, (_key, item) => {
    if (
      typeof item === "object" &&
      item !== null &&
      Array.isArray((item as { __domsynBytes?: unknown }).__domsynBytes)
    ) {
      return Uint8Array.from((item as { __domsynBytes: number[] }).__domsynBytes);
    }
    return item;
  }) as T;
}

function messageBytes(data: ArrayBuffer | Blob): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(data));
  return data.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

function receiveInitialSnapshot(target: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener("message", onMessage);
      target.removeEventListener("error", onError);
      target.removeEventListener("close", onClose);
    };
    const onMessage = (event: MessageEvent<ArrayBuffer | Blob | string>) => {
      if (typeof event.data === "string") return;
      cleanup();
      void messageBytes(event.data).then(resolve, reject);
    };
    const onError = () => {
      cleanup();
      reject(new Error("Could not connect to the space WebSocket"));
    };
    const onClose = (event: CloseEvent) => {
      cleanup();
      reject(new Error(`Space WebSocket closed before hydration (${event.code})`));
    };
    target.addEventListener("message", onMessage);
    target.addEventListener("error", onError);
    target.addEventListener("close", onClose);
  });
}

renderState();
appendEvent("system", "Hydrated the DOM from the server space actor");

window.addEventListener("beforeunload", () => {
  unsubscribeDoc();
  unsubscribeUpdates();
  presence.destroy();
  presenceStore.destroy();
  socket.close();
  sync.destroy();
});
