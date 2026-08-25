import {
  createDomCrdt,
  createDomCrdtPresencePointAdapter,
  createDomPresence,
  createPresenceStore,
  LoroDoc,
  type DomCrdtSync,
  type Presence,
  type PresencePoint,
} from "../src/index.ts";
import type { LoroEvent, LoroEventBatch } from "loro-crdt";

type ChannelMessage =
  | { kind: "hello" | "goodbye"; sender: string; target?: string }
  | { kind: "presence"; sender: string; target?: string; presence: Presence<PresencePoint> }
  | { kind: "update"; sender: string; target?: string; update: Uint8Array };

const root = requiredElement<HTMLElement>("#document-root");
const spaceId = decodeURIComponent(location.pathname.split("/").filter(Boolean).at(-1) ?? "local");
const tabId = crypto.randomUUID();
const storageKey = `domsyn:space:${spaceId}`;
const channel = new BroadcastChannel(`domsyn:${spaceId}`);
const storedSnapshot = readStoredSnapshot();
const sync = createDomCrdt({
  root,
  doc: storedSnapshot ? LoroDoc.fromSnapshot(storedSnapshot) : undefined,
});
const presenceLayer = requiredElement<HTMLElement>("#presence-layer");
const presenceStore = createPresenceStore<PresencePoint>({
  peerId: tabId,
  name: `Peer ${shortId(tabId)}`,
  color: peerColor(tabId),
  send: (presence) => {
    channel.postMessage({ kind: "presence", sender: tabId, presence } satisfies ChannelMessage);
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
  channel.postMessage({ kind: "update", sender: tabId, update } satisfies ChannelMessage);
  appendEvent("outgoing", `Broadcast ${formatBytes(update.byteLength)} update`, {
    bytes: update.byteLength,
  }, update.byteLength);
  queueMicrotask(() => persist(sync));
});

const unsubscribeDoc = sync.doc.subscribe((batch) => {
  appendCrdtBatch(batch, batch.by === "import" ? importingUpdateBytes : undefined);
  queueMicrotask(renderState);
});

channel.addEventListener("message", (event: MessageEvent<ChannelMessage>) => {
  const message = event.data;
  if (!message || message.sender === tabId || (message.target && message.target !== tabId)) return;
  peers.add(message.sender);

  if (message.kind === "hello") {
    channel.postMessage({
      kind: "update",
      sender: tabId,
      target: message.sender,
      update: sync.getUpdate(),
    } satisfies ChannelMessage);
    presenceStore.broadcastLocal();
  } else if (message.kind === "goodbye") {
    peers.delete(message.sender);
    presenceStore.remove(message.sender);
  } else if (message.kind === "presence" && message.presence.peerId === message.sender) {
    presenceStore.receive(message.presence);
  } else if (message.kind === "update") {
    const update = new Uint8Array(message.update);
    appendEvent("incoming", `Received ${formatBytes(update.byteLength)} update`, {
      bytes: update.byteLength,
      sender: shortId(message.sender),
    }, update.byteLength);
    importingUpdateBytes = update.byteLength;
    try {
      sync.applyUpdate(update);
    } finally {
      importingUpdateBytes = undefined;
    }
    persist(sync);
    presence.refresh();
  }

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
  const count = peers.size;
  output.value = count === 0 ? "Live · waiting for another tab" : `Live · ${count} other tab${count === 1 ? "" : "s"}`;
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

function readStoredSnapshot(): Uint8Array | undefined {
  const encoded = localStorage.getItem(storageKey);
  if (!encoded) return undefined;
  try {
    const binary = atob(encoded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    localStorage.removeItem(storageKey);
    return undefined;
  }
}

function persist(target: DomCrdtSync): void {
  const snapshot = target.getSnapshot();
  let binary = "";
  for (const byte of snapshot) binary += String.fromCharCode(byte);
  localStorage.setItem(storageKey, btoa(binary));
}

persist(sync);
renderState();
appendEvent("system", storedSnapshot ? "Hydrated the DOM from the stored CRDT snapshot" : "Imported the initial DOM into a new CRDT");
channel.postMessage({ kind: "hello", sender: tabId } satisfies ChannelMessage);

window.addEventListener("beforeunload", () => {
  channel.postMessage({ kind: "goodbye", sender: tabId } satisfies ChannelMessage);
  persist(sync);
  unsubscribeDoc();
  unsubscribeUpdates();
  presence.destroy();
  presenceStore.destroy();
  channel.close();
  sync.destroy();
});
