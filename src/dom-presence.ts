import type { Presence, PresenceStore } from "./presence.ts";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

export interface DomPresencePoint {
  node: Node;
  offset: number;
}

export interface PresencePointAdapter<TPoint> {
  capture(node: Node, offset: number): TPoint | undefined;
  resolve(point: TPoint): DomPresencePoint | undefined;
}

export interface CreateDomPresenceOptions<TPoint> {
  root: Element;
  layer: HTMLElement;
  store: PresenceStore<TPoint>;
  pointAdapter: PresencePointAdapter<TPoint>;
  beforeCapture?: () => void;
}

export interface DomPresenceController {
  capture(): void;
  refresh(): void;
  destroy(): void;
}

interface HighlightRegistryLike {
  set(name: string, value: unknown): unknown;
  delete(name: string): boolean;
}

interface HighlightConstructorLike {
  new (...ranges: Range[]): unknown;
}

interface PeerVisual {
  caret: HTMLDivElement;
  label: HTMLSpanElement;
  highlightName: string;
}

interface CaretRect {
  left: number;
  top: number;
  height: number;
}

class DomPresenceControllerImpl<TPoint> implements DomPresenceController {
  private readonly root: Element;
  private readonly layer: HTMLElement;
  private readonly store: PresenceStore<TPoint>;
  private readonly pointAdapter: PresencePointAdapter<TPoint>;
  private readonly beforeCapture: (() => void) | undefined;
  private readonly document: Document;
  private readonly view: Window;
  private readonly highlights: HighlightRegistryLike | undefined;
  private readonly HighlightConstructor: HighlightConstructorLike | undefined;
  private readonly visuals = new Map<string, PeerVisual>();
  private readonly style: HTMLStyleElement;
  private readonly unsubscribeStore: () => void;
  private readonly resizeObserver: ResizeObserver | undefined;
  private readonly mutationObserver: MutationObserver | undefined;
  private animationFrame: number | undefined;
  private captureFrame: number | undefined;
  private destroyed = false;

  constructor(options: CreateDomPresenceOptions<TPoint>) {
    this.root = options.root;
    this.layer = options.layer;
    this.store = options.store;
    this.pointAdapter = options.pointAdapter;
    this.beforeCapture = options.beforeCapture;
    this.document = this.root.ownerDocument;
    const view = this.document.defaultView;
    if (!view) throw new Error("DOM presence requires a document with a Window");
    if (this.root === this.layer || this.root.contains(this.layer)) {
      throw new Error("The presence layer must be outside the synchronized root");
    }
    this.view = view;

    const presenceGlobals = view as unknown as {
      CSS?: { highlights?: HighlightRegistryLike };
      Highlight?: HighlightConstructorLike;
    };
    this.highlights = presenceGlobals.CSS?.highlights;
    this.HighlightConstructor = presenceGlobals.Highlight;

    this.layer.setAttribute("aria-hidden", "true");
    this.style = this.document.createElement("style");
    this.style.dataset.domsynPresence = "";
    this.document.head.append(this.style);

    this.unsubscribeStore = this.store.subscribe(() => this.refresh());
    this.document.addEventListener("selectionchange", this.onSelectionChange);
    this.view.addEventListener("scroll", this.onLayoutChange, true);
    this.view.addEventListener("resize", this.onLayoutChange);

    const ResizeObserverConstructor = view.ResizeObserver ?? globalThis.ResizeObserver;
    this.resizeObserver = ResizeObserverConstructor
      ? new ResizeObserverConstructor(this.onLayoutChange)
      : undefined;
    this.resizeObserver?.observe(this.root);

    const MutationObserverConstructor = view.MutationObserver ?? globalThis.MutationObserver;
    this.mutationObserver = MutationObserverConstructor
      ? new MutationObserverConstructor(this.onLayoutChange)
      : undefined;
    this.mutationObserver?.observe(this.root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    this.refresh();
  }

  capture(): void {
    if (this.destroyed) return;
    this.beforeCapture?.();
    const selection = this.view.getSelection();
    const anchorNode = selection?.anchorNode;
    const focusNode = selection?.focusNode;
    if (
      !selection ||
      selection.rangeCount === 0 ||
      !anchorNode ||
      !focusNode ||
      !this.isInsideRoot(anchorNode) ||
      !this.isInsideRoot(focusNode)
    ) {
      this.store.clearLocal();
      return;
    }

    const anchor = this.pointAdapter.capture(anchorNode, selection.anchorOffset);
    const focus = this.pointAdapter.capture(focusNode, selection.focusOffset);
    if (!anchor || !focus) {
      this.store.clearLocal();
      return;
    }
    this.store.updateLocal(anchor, focus);
  }

  refresh(): void {
    if (this.destroyed || this.animationFrame !== undefined) return;
    this.animationFrame = this.requestFrame(() => {
      this.animationFrame = undefined;
      this.render();
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribeStore();
    this.document.removeEventListener("selectionchange", this.onSelectionChange);
    this.view.removeEventListener("scroll", this.onLayoutChange, true);
    this.view.removeEventListener("resize", this.onLayoutChange);
    this.resizeObserver?.disconnect();
    this.mutationObserver?.disconnect();
    if (this.animationFrame !== undefined) this.cancelFrame(this.animationFrame);
    if (this.captureFrame !== undefined) this.cancelFrame(this.captureFrame);
    for (const peerId of Array.from(this.visuals.keys())) this.removeVisual(peerId);
    this.style.remove();
  }

  private readonly onSelectionChange = (): void => {
    if (this.destroyed || this.captureFrame !== undefined) return;
    this.captureFrame = this.requestFrame(() => {
      this.captureFrame = undefined;
      this.capture();
    });
  };

  private readonly onLayoutChange = (): void => {
    this.refresh();
  };

  private render(): void {
    const remotes = this.store.getRemotes();
    const livePeerIds = new Set(remotes.map(({ peerId }) => peerId));
    for (const peerId of Array.from(this.visuals.keys())) {
      if (!livePeerIds.has(peerId)) this.removeVisual(peerId);
    }

    this.renderHighlightStyles(remotes);
    for (const presence of remotes) this.renderPresence(presence);
  }

  private renderPresence(presence: Presence<TPoint>): void {
    const visual = this.ensureVisual(presence);
    const anchor = this.safeResolve(presence.anchor);
    const focus = this.safeResolve(presence.focus);
    if (!anchor || !focus || !this.isInsideRoot(anchor.node) || !this.isInsideRoot(focus.node)) {
      this.highlights?.delete(visual.highlightName);
      visual.caret.hidden = true;
      return;
    }

    const selectionRange = this.createOrderedRange(anchor, focus);
    if (selectionRange && !selectionRange.collapsed && this.highlights && this.HighlightConstructor) {
      this.highlights.set(visual.highlightName, new this.HighlightConstructor(selectionRange));
    } else {
      this.highlights?.delete(visual.highlightName);
    }

    const rect = this.measureCaret(focus);
    if (!rect) {
      visual.caret.hidden = true;
      return;
    }

    visual.caret.hidden = false;
    visual.caret.style.left = `${rect.left}px`;
    visual.caret.style.top = `${rect.top}px`;
    visual.caret.style.height = `${Math.max(1, rect.height)}px`;
    visual.caret.style.backgroundColor = safeColor(presence.color);
    visual.label.style.backgroundColor = safeColor(presence.color);
    visual.label.textContent = presence.name;
  }

  private ensureVisual(presence: Presence<TPoint>): PeerVisual {
    const existing = this.visuals.get(presence.peerId);
    if (existing) return existing;

    const caret = this.document.createElement("div");
    caret.className = "remote-caret";
    caret.dataset.peerId = presence.peerId;
    const label = this.document.createElement("span");
    label.className = "remote-caret-label";
    caret.append(label);
    this.layer.append(caret);

    const visual = {
      caret,
      label,
      highlightName: highlightName(presence.peerId),
    };
    this.visuals.set(presence.peerId, visual);
    return visual;
  }

  private removeVisual(peerId: string): void {
    const visual = this.visuals.get(peerId);
    if (!visual) return;
    this.highlights?.delete(visual.highlightName);
    visual.caret.remove();
    this.visuals.delete(peerId);
  }

  private renderHighlightStyles(remotes: Presence<TPoint>[]): void {
    this.style.textContent = remotes.map((presence) => {
      const color = transparentColor(safeColor(presence.color));
      return `::highlight(${highlightName(presence.peerId)}) { background-color: ${color}; }`;
    }).join("\n");
  }

  private safeResolve(point: TPoint): DomPresencePoint | undefined {
    try {
      return this.pointAdapter.resolve(point);
    } catch {
      return undefined;
    }
  }

  private createOrderedRange(
    anchor: DomPresencePoint,
    focus: DomPresencePoint,
  ): Range | undefined {
    try {
      const anchorRange = this.document.createRange();
      anchorRange.setStart(anchor.node, clampDomOffset(anchor.node, anchor.offset));
      anchorRange.collapse(true);
      const focusRange = this.document.createRange();
      focusRange.setStart(focus.node, clampDomOffset(focus.node, focus.offset));
      focusRange.collapse(true);

      const range = this.document.createRange();
      if (anchorRange.compareBoundaryPoints(0, focusRange) <= 0) {
        range.setStart(anchorRange.startContainer, anchorRange.startOffset);
        range.setEnd(focusRange.startContainer, focusRange.startOffset);
      } else {
        range.setStart(focusRange.startContainer, focusRange.startOffset);
        range.setEnd(anchorRange.startContainer, anchorRange.startOffset);
      }
      return range;
    } catch {
      return undefined;
    }
  }

  private measureCaret(point: DomPresencePoint): CaretRect | undefined {
    try {
      const offset = clampDomOffset(point.node, point.offset);
      const collapsed = this.document.createRange();
      collapsed.setStart(point.node, offset);
      collapsed.collapse(true);
      const direct = firstUsableRect(collapsed.getClientRects());
      if (direct) return { left: direct.left, top: direct.top, height: direct.height };

      if (point.node.nodeType === TEXT_NODE) {
        const text = point.node as Text;
        if (offset > 0) {
          const previous = this.document.createRange();
          previous.setStart(text, offset - 1);
          previous.setEnd(text, offset);
          const rect = lastUsableRect(previous.getClientRects());
          if (rect) return { left: rect.right, top: rect.top, height: rect.height };
        }
        if (offset < text.data.length) {
          const next = this.document.createRange();
          next.setStart(text, offset);
          next.setEnd(text, offset + 1);
          const rect = firstUsableRect(next.getClientRects());
          if (rect) return { left: rect.left, top: rect.top, height: rect.height };
        }
      }

      return this.measureEditableFallback(point.node);
    } catch {
      return undefined;
    }
  }

  private measureEditableFallback(node: Node): CaretRect | undefined {
    const element = node.nodeType === ELEMENT_NODE
      ? node as Element
      : node.parentElement;
    const editable = element?.closest<HTMLElement>(
      '[contenteditable="true"], [contenteditable="plaintext-only"]',
    );
    if (!editable || !this.root.contains(editable)) return undefined;

    const bounds = editable.getBoundingClientRect();
    const computed = this.view.getComputedStyle(editable);
    const fontSize = Number.parseFloat(computed.fontSize) || 16;
    const parsedLineHeight = Number.parseFloat(computed.lineHeight);
    const lineHeight = Number.isFinite(parsedLineHeight) ? parsedLineHeight : fontSize * 1.2;
    return {
      left: bounds.left + (Number.parseFloat(computed.paddingLeft) || 0),
      top: bounds.top + (Number.parseFloat(computed.paddingTop) || 0),
      height: Math.max(1, lineHeight),
    };
  }

  private isInsideRoot(node: Node): boolean {
    return node === this.root || this.root.contains(node);
  }

  private requestFrame(callback: FrameRequestCallback): number {
    return this.view.requestAnimationFrame
      ? this.view.requestAnimationFrame(callback)
      : this.view.setTimeout(() => callback(this.view.performance.now()), 16);
  }

  private cancelFrame(handle: number): void {
    if (this.view.cancelAnimationFrame) this.view.cancelAnimationFrame(handle);
    else this.view.clearTimeout(handle);
  }
}

function clampDomOffset(node: Node, offset: number): number {
  const length = node.nodeType === TEXT_NODE
    ? (node as Text).data.length
    : node.childNodes.length;
  return Math.max(0, Math.min(Number.isFinite(offset) ? Math.floor(offset) : 0, length));
}

function firstUsableRect(rects: DOMRectList): DOMRect | undefined {
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects.item(index);
    if (rect && rect.height > 0) return rect;
  }
  return undefined;
}

function lastUsableRect(rects: DOMRectList): DOMRect | undefined {
  for (let index = rects.length - 1; index >= 0; index -= 1) {
    const rect = rects.item(index);
    if (rect && rect.height > 0) return rect;
  }
  return undefined;
}

function highlightName(peerId: string): string {
  const encoded = Array.from(peerId, (character) => {
    return /[a-zA-Z0-9_-]/.test(character)
      ? character
      : `_${character.codePointAt(0)?.toString(16) ?? "0"}_`;
  }).join("");
  return `domsyn-peer-${encoded}`;
}

function safeColor(color: string): string {
  const trimmed = color.trim();
  if (!trimmed || /[;{}]/.test(trimmed)) return "#5b6ee1";
  return trimmed;
}

function transparentColor(color: string): string {
  if (/^#[\da-f]{6}$/i.test(color)) return `${color}38`;
  if (/^#[\da-f]{3}$/i.test(color)) return `${color}4`;
  return `color-mix(in srgb, ${color} 22%, transparent)`;
}

export function createDomPresence<TPoint>(
  options: CreateDomPresenceOptions<TPoint>,
): DomPresenceController {
  return new DomPresenceControllerImpl(options);
}
