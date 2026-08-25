import {
  LoroDoc,
  LoroMap,
  LoroText,
  type Cursor,
  type LoroTree,
  type LoroTreeNode,
  type TreeID,
  type VersionVector,
} from "loro-crdt";

const TREE_NAME = "dom";
const ROOT_KIND = "root";
const ELEMENT_KIND = "element";
const TEXT_KIND = "text";
const ATTRIBUTES_KEY = "attributes";
const TEXT_KEY = "text";
const LOCAL_NAME_KEY = "localName";
const LEGACY_TAG_NAME_KEY = "tagName";
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const NAMESPACED_ATTRIBUTE_PREFIX = "\u0001";

type SupportedNode = Element | Text;
type UpdateListener = (update: Uint8Array) => void;

export interface CreateDomCrdtOptions {
  root: Element;
  doc?: LoroDoc;
  /** Origin attached to local DOM-derived Loro commits. */
  origin?: string;
}

export interface DomCrdtSync {
  readonly doc: LoroDoc;
  readonly root: Element;
  destroy(): void;
  flush(): void;
  getUpdate(from?: VersionVector): Uint8Array;
  getSnapshot(): Uint8Array;
  applyUpdate(update: Uint8Array): void;
  onUpdate(listener: UpdateListener): () => void;
  getCrdtNode(domNode: Node): TreeID | undefined;
  getDomNode(crdtNodeId: TreeID): Node | undefined;
  dumpTree(): string;
}

interface AttributeState {
  namespaceURI: string | null;
  localName: string;
  name: string;
  value: string;
}

interface SelectionPointSnapshot {
  node: Node;
  offset: number;
  childAfter?: Node;
  textNodeId?: TreeID;
  cursor?: Cursor;
  cursorOffsetAdjustment?: number;
}

interface SelectionSnapshot {
  anchor: SelectionPointSnapshot;
  focus: SelectionPointSnapshot;
}

type SelectionBoundary = "caret" | "start" | "end";

function isSupportedNode(node: Node): node is SupportedNode {
  return node.nodeType === ELEMENT_NODE || node.nodeType === TEXT_NODE;
}

function isElement(node: Node): node is Element {
  return node.nodeType === ELEMENT_NODE;
}

function supportedChildren(parent: Node): SupportedNode[] {
  return Array.from(parent.childNodes).filter(isSupportedNode);
}

function attributeKey(namespaceURI: string | null, localName: string): string {
  return namespaceURI === null
    ? localName
    : `${NAMESPACED_ATTRIBUTE_PREFIX}${JSON.stringify([namespaceURI, localName])}`;
}

function attributeState(attribute: Attr): AttributeState {
  return {
    namespaceURI: attribute.namespaceURI,
    localName: attribute.localName,
    name: attribute.name,
    value: attribute.value,
  };
}

function encodeAttribute(attribute: Attr): string | AttributeState {
  return attribute.namespaceURI === null ? attribute.value : attributeState(attribute);
}

function decodeAttribute(key: string, value: unknown): AttributeState | undefined {
  if (!key.startsWith(NAMESPACED_ATTRIBUTE_PREFIX) && !key.startsWith("[")) {
    return typeof value === "string"
      ? { namespaceURI: null, localName: key, name: key, value }
      : undefined;
  }

  if (key.startsWith(NAMESPACED_ATTRIBUTE_PREFIX) && typeof value === "object" && value !== null) {
    try {
      const [namespaceURI, localName] = JSON.parse(
        key.slice(NAMESPACED_ATTRIBUTE_PREFIX.length),
      ) as [unknown, unknown];
      const descriptor = value as Partial<AttributeState>;
      if (
        typeof namespaceURI === "string" &&
        typeof localName === "string" &&
        typeof descriptor.name === "string" &&
        typeof descriptor.value === "string"
      ) {
        return {
          namespaceURI,
          localName,
          name: descriptor.name,
          value: descriptor.value,
        };
      }
    } catch {
      return undefined;
    }
  }

  // Backward compatibility for the prototype's original
  // `[namespaceURI, localName]` key + JSON-string descriptor schema.
  if (typeof value !== "string") return undefined;

  try {
    const parsed = JSON.parse(value) as Partial<AttributeState>;
    if (
      (parsed.namespaceURI === null || typeof parsed.namespaceURI === "string") &&
      typeof parsed.localName === "string" &&
      typeof parsed.name === "string" &&
      typeof parsed.value === "string"
    ) {
      return parsed as AttributeState;
    }
  } catch {
    // A malformed value is ignored so one bad attribute cannot stop projection.
  }

  return undefined;
}

function commonAffixes(before: string, after: string) {
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  const maxSuffix = Math.min(before.length - prefix, after.length - prefix);
  while (
    suffix < maxSuffix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix += 1;
  }

  return { prefix, suffix };
}

function directCrdtChildren(node: LoroTreeNode | undefined) {
  return node?.children() ?? [];
}

class DomCrdtSyncImpl implements DomCrdtSync {
  readonly doc: LoroDoc;
  readonly root: Element;

  private readonly tree: LoroTree;
  private readonly idToDom = new Map<TreeID, Node>();
  private readonly domToId = new WeakMap<Node, TreeID>();
  private readonly updateListeners = new Set<UpdateListener>();
  private readonly localOrigin: string;
  private readonly observer: MutationObserver;
  private readonly unsubscribeDoc: () => void;
  private readonly unsubscribeLocalUpdates: () => void;
  private rootId!: TreeID;
  private destroyed = false;
  private processingMutations = false;
  private projecting = false;

  constructor(options: CreateDomCrdtOptions) {
    this.root = options.root;
    this.doc = options.doc ?? new LoroDoc();
    this.localOrigin = options.origin ?? `dom-crdt:${crypto.randomUUID()}`;
    this.tree = this.doc.getTree(TREE_NAME);
    this.tree.enableFractionalIndex(16);

    const roots = this.tree.roots().filter((node) => !node.isDeleted());
    if (roots.length === 0) {
      const crdtRoot = this.tree.createNode();
      crdtRoot.data.set("type", ROOT_KIND);
      this.rootId = crdtRoot.id;
      this.bind(this.rootId, this.root);

      for (const child of supportedChildren(this.root)) {
        this.createCrdtNode(child, crdtRoot);
      }

      this.doc.commit({ origin: `${this.localOrigin}:initial-import` });
    } else {
      if (roots.length !== 1 || roots[0]?.data.get("type") !== ROOT_KIND) {
        throw new Error(
          `The \"${TREE_NAME}\" Loro tree must contain exactly one DOM CRDT root`,
        );
      }

      this.rootId = roots[0].id;
      this.migrateLegacyElementMetadata();
      this.bind(this.rootId, this.root);
      this.projectFromCrdt();
    }

    const MutationObserverConstructor =
      this.root.ownerDocument.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    if (!MutationObserverConstructor) {
      throw new Error("MutationObserver is required to synchronize a DOM subtree");
    }

    this.observer = new MutationObserverConstructor((records) => {
      this.processMutationBatch(records);
    });
    this.observe();

    this.unsubscribeLocalUpdates = this.doc.subscribeLocalUpdates((update) => {
      for (const listener of this.updateListeners) listener(update);
    });

    this.unsubscribeDoc = this.doc.subscribe((event) => {
      if (this.destroyed || event.origin?.startsWith(this.localOrigin)) return;

      // Imports normally enter through applyUpdate(), which projects synchronously.
      // This also supports callers that import or edit the exposed LoroDoc directly.
      queueMicrotask(() => {
        if (this.destroyed || this.projecting) return;
        this.flush();
        const selection = this.captureSelection();
        this.withObserverDisconnected(() => {
          try {
            this.projectFromCrdt();
          } finally {
            this.restoreSelection(selection);
          }
        });
      });
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.flush();
    this.destroyed = true;
    this.observer.disconnect();
    this.unsubscribeDoc();
    this.unsubscribeLocalUpdates();
    this.updateListeners.clear();
  }

  flush(): void {
    if (this.destroyed || this.processingMutations || this.projecting) return;
    const records = this.observer.takeRecords();
    if (records.length > 0) this.processMutationBatch(records);
  }

  getUpdate(from?: VersionVector): Uint8Array {
    this.flush();
    return this.doc.export({ mode: "update", from });
  }

  getSnapshot(): Uint8Array {
    this.flush();
    return this.doc.export({ mode: "snapshot" });
  }

  applyUpdate(update: Uint8Array): void {
    if (this.destroyed) throw new Error("Cannot update a destroyed DOM CRDT sync");

    // Do not lose legitimate local records when disconnecting the observer.
    this.flush();
    const selection = this.captureSelection();
    this.withObserverDisconnected(() => {
      try {
        this.doc.import(update);
        this.projectFromCrdt();
      } finally {
        this.restoreSelection(selection);
      }
    });
  }

  onUpdate(listener: UpdateListener): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  getCrdtNode(domNode: Node): TreeID | undefined {
    return this.domToId.get(domNode);
  }

  getDomNode(crdtNodeId: TreeID): Node | undefined {
    return this.idToDom.get(crdtNodeId);
  }

  dumpTree(): string {
    this.flush();
    const rootNode = this.tree.getNodeByID(this.rootId);
    if (!rootNode || rootNode.isDeleted()) return "<deleted root>";

    const lines = [`root #${this.rootId}`];
    const children = directCrdtChildren(rootNode);
    children.forEach((child, index) => {
      this.dumpNode(child, "", index === children.length - 1, lines);
    });
    return lines.join("\n");
  }

  private observe(): void {
    this.observer.observe(this.root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
      characterDataOldValue: true,
      attributeOldValue: true,
    });
  }

  private withObserverDisconnected(callback: () => void): void {
    if (this.projecting) {
      callback();
      return;
    }

    this.projecting = true;
    this.observer.disconnect();
    try {
      callback();
      // This is normally empty because disconnected observers do not enqueue.
      // Taking records makes that invariant explicit across DOM implementations.
      this.observer.takeRecords();
    } finally {
      this.observe();
      this.projecting = false;
    }
  }

  private captureSelection(): SelectionSnapshot | undefined {
    const selection = this.root.ownerDocument.defaultView?.getSelection();
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
      return undefined;
    }

    const range = selection.getRangeAt(0);
    const boundaryFor = (node: Node, offset: number): SelectionBoundary => {
      if (selection.isCollapsed) return "caret";
      return node === range.startContainer && offset === range.startOffset ? "start" : "end";
    };

    return {
      anchor: this.captureSelectionPoint(
        anchorNode,
        selection.anchorOffset,
        boundaryFor(anchorNode, selection.anchorOffset),
      ),
      focus: this.captureSelectionPoint(
        focusNode,
        selection.focusOffset,
        boundaryFor(focusNode, selection.focusOffset),
      ),
    };
  }

  private captureSelectionPoint(
    node: Node,
    offset: number,
    boundary: SelectionBoundary,
  ): SelectionPointSnapshot {
    if (node.nodeType === TEXT_NODE) {
      const textNode = node as Text;
      const safeOffset = Math.max(0, Math.min(offset, textNode.data.length));
      const textNodeId = this.domToId.get(textNode);
      const crdtNode = textNodeId ? this.tree.getNodeByID(textNodeId) : undefined;
      const text = crdtNode?.data.get(TEXT_KEY);
      // A range start sticks to the character on its right. A range end
      // sticks immediately after the character on its left, preventing text
      // inserted exactly at either outer boundary from joining the selection.
      const anchorToPreviousCharacter = boundary === "end" && safeOffset > 0;
      const cursorOffset = anchorToPreviousCharacter ? safeOffset - 1 : safeOffset;
      return {
        node,
        offset: safeOffset,
        textNodeId,
        cursor: text instanceof LoroText ? text.getCursor(cursorOffset, 0) : undefined,
        cursorOffsetAdjustment: anchorToPreviousCharacter ? 1 : 0,
      };
    }

    const safeOffset = Math.max(0, Math.min(offset, node.childNodes.length));
    return {
      node,
      offset: safeOffset,
      childAfter: node.childNodes[safeOffset],
    };
  }

  private restoreSelection(snapshot: SelectionSnapshot | undefined): void {
    if (!snapshot) return;

    try {
      const anchor = this.resolveSelectionPoint(snapshot.anchor);
      const focus = this.resolveSelectionPoint(snapshot.focus);
      const selection = this.root.ownerDocument.defaultView?.getSelection();
      if (!anchor || !focus || !selection) return;
      selection.setBaseAndExtent(
        anchor.node,
        anchor.offset,
        focus.node,
        focus.offset,
      );
    } catch {
      // A concurrently deleted selection endpoint should not prevent projection.
    } finally {
      snapshot.anchor.cursor?.free();
      snapshot.focus.cursor?.free();
    }
  }

  private resolveSelectionPoint(
    point: SelectionPointSnapshot,
  ): { node: Node; offset: number } | undefined {
    if (point.textNodeId && point.cursor) {
      const crdtNode = this.tree.getNodeByID(point.textNodeId);
      const domNode = this.idToDom.get(point.textNodeId);
      const text = crdtNode?.data.get(TEXT_KEY);
      const position = this.doc.getCursorPos(point.cursor);
      if (
        crdtNode &&
        !crdtNode.isDeleted() &&
        domNode?.nodeType === TEXT_NODE &&
        text instanceof LoroText &&
        position &&
        this.isInsideRoot(domNode)
      ) {
        return {
          node: domNode,
          offset: Math.max(
            0,
            Math.min(
              position.offset + (point.cursorOffsetAdjustment ?? 0),
              (domNode as Text).data.length,
            ),
          ),
        };
      }
    }

    if (!this.isInsideRoot(point.node)) return undefined;
    if (point.node.nodeType === TEXT_NODE) {
      return {
        node: point.node,
        offset: Math.max(0, Math.min(point.offset, (point.node as Text).data.length)),
      };
    }

    const childIndex = point.childAfter?.parentNode === point.node
      ? Array.prototype.indexOf.call(point.node.childNodes, point.childAfter) as number
      : -1;
    return {
      node: point.node,
      offset: childIndex >= 0
        ? childIndex
        : Math.max(0, Math.min(point.offset, point.node.childNodes.length)),
    };
  }

  private isInsideRoot(node: Node): boolean {
    return node === this.root || this.root.contains(node);
  }

  private bind(id: TreeID, domNode: Node): void {
    const previousDom = this.idToDom.get(id);
    if (previousDom && previousDom !== domNode) this.domToId.delete(previousDom);

    const previousId = this.domToId.get(domNode);
    if (previousId && previousId !== id) this.idToDom.delete(previousId);

    this.idToDom.set(id, domNode);
    this.domToId.set(domNode, id);
  }

  private migrateLegacyElementMetadata(): void {
    let changed = false;
    for (const node of this.tree.getNodes()) {
      if (node.isDeleted() || node.data.get("type") !== ELEMENT_KIND) continue;
      const localName = node.data.get(LOCAL_NAME_KEY);
      const legacyTagName = node.data.get(LEGACY_TAG_NAME_KEY);
      if (typeof localName !== "string" && typeof legacyTagName === "string") {
        node.data.set(LOCAL_NAME_KEY, legacyTagName);
        changed = true;
      }
      if (legacyTagName !== undefined) {
        node.data.delete(LEGACY_TAG_NAME_KEY);
        changed = true;
      }
    }
    if (changed) this.doc.commit({ origin: `${this.localOrigin}:local-name-migration` });
  }

  private readElementLocalName(crdtNode: LoroTreeNode): string | undefined {
    const localName = crdtNode.data.get(LOCAL_NAME_KEY);
    if (typeof localName === "string") return localName;
    const legacyTagName = crdtNode.data.get(LEGACY_TAG_NAME_KEY);
    return typeof legacyTagName === "string" ? legacyTagName : undefined;
  }

  private unbind(id: TreeID): void {
    const domNode = this.idToDom.get(id);
    if (domNode) this.domToId.delete(domNode);
    this.idToDom.delete(id);
  }

  private createCrdtNode(
    domNode: SupportedNode,
    parent: LoroTreeNode,
  ): LoroTreeNode {
    const crdtNode = parent.createNode();
    this.bind(crdtNode.id, domNode);

    if (isElement(domNode)) {
      crdtNode.data.set("type", ELEMENT_KIND);
      crdtNode.data.set("namespaceURI", domNode.namespaceURI);
      crdtNode.data.set(LOCAL_NAME_KEY, domNode.localName);
      this.syncAttributesToCrdt(domNode, crdtNode.data.ensureMergeableMap(ATTRIBUTES_KEY));

      for (const child of supportedChildren(domNode)) {
        this.createCrdtNode(child, crdtNode);
      }
    } else {
      crdtNode.data.set("type", TEXT_KIND);
      const text = crdtNode.data.ensureMergeableText(TEXT_KEY);
      if (domNode.data.length > 0) text.insert(0, domNode.data);
    }

    return crdtNode;
  }

  private processMutationBatch(records: MutationRecord[]): void {
    if (this.destroyed || this.projecting || this.processingMutations || records.length === 0) {
      return;
    }

    this.processingMutations = true;
    try {
      // Mutation records are intentionally consumed as one batch. The final DOM,
      // rather than record order, tells us whether a known node moved or vanished.
      const liveDomNodes = this.walkDom();

      // Preorder guarantees that an unknown parent is assigned an ID before any
      // unknown descendants. Known descendants retain their existing IDs.
      for (const domNode of liveDomNodes) {
        if (this.domToId.has(domNode)) continue;
        const parentDom = domNode.parentNode;
        const parentId = parentDom ? this.domToId.get(parentDom) : undefined;
        const parent = parentId ? this.tree.getNodeByID(parentId) : undefined;
        if (!parent || parent.isDeleted()) continue;
        this.createCrdtNodeShallow(domNode, parent);
      }

      const liveSet = new Set<Node>(liveDomNodes);
      liveSet.add(this.root);
      const staleIds = new Set<TreeID>();
      for (const [id, domNode] of this.idToDom) {
        if (id !== this.rootId && !liveSet.has(domNode)) staleIds.add(id);
      }

      // If a descendant escaped a subtree that is being deleted in this same
      // observer delivery, move it out before deleting the stale ancestor.
      for (const domNode of liveDomNodes) {
        const id = this.domToId.get(domNode);
        const desiredParentId = domNode.parentNode
          ? this.domToId.get(domNode.parentNode)
          : undefined;
        if (!id || !desiredParentId) continue;
        const crdtNode = this.tree.getNodeByID(id);
        const currentParentId = crdtNode?.parent()?.id;
        if (currentParentId && staleIds.has(currentParentId)) {
          this.tree.move(id, desiredParentId);
        }
      }

      for (const id of staleIds) {
        const crdtNode = this.tree.getNodeByID(id);
        const parentId = crdtNode?.parent()?.id;
        if (!crdtNode || crdtNode.isDeleted() || (parentId && staleIds.has(parentId))) continue;
        this.tree.delete(id);
      }
      for (const id of staleIds) this.unbind(id);

      // Reconcile all live parent/index relationships. Calls are only emitted for
      // actual mismatches, and tree.move preserves the node's CRDT identity.
      for (const domNode of liveDomNodes) {
        const id = this.domToId.get(domNode);
        const parentId = domNode.parentNode
          ? this.domToId.get(domNode.parentNode)
          : undefined;
        if (!id || !parentId) continue;

        const crdtNode = this.tree.getNodeByID(id);
        const desiredIndex = supportedChildren(domNode.parentNode as Node).indexOf(domNode);
        if (
          crdtNode &&
          !crdtNode.isDeleted() &&
          (crdtNode.parent()?.id !== parentId || crdtNode.index() !== desiredIndex)
        ) {
          this.tree.move(id, parentId, desiredIndex);
        }
      }

      // Full state comparison is deliberate: it coalesces repeated MutationRecords
      // and also captures edits made while a known subtree was temporarily detached.
      for (const domNode of liveDomNodes) this.syncNodeStateToCrdt(domNode);

      this.doc.commit({ origin: this.localOrigin });
    } finally {
      this.processingMutations = false;
    }
  }

  private createCrdtNodeShallow(
    domNode: SupportedNode,
    parent: LoroTreeNode,
  ): void {
    const crdtNode = parent.createNode();
    this.bind(crdtNode.id, domNode);

    if (isElement(domNode)) {
      crdtNode.data.set("type", ELEMENT_KIND);
      crdtNode.data.set("namespaceURI", domNode.namespaceURI);
      crdtNode.data.set(LOCAL_NAME_KEY, domNode.localName);
      this.syncAttributesToCrdt(domNode, crdtNode.data.ensureMergeableMap(ATTRIBUTES_KEY));
    } else {
      crdtNode.data.set("type", TEXT_KIND);
      const text = crdtNode.data.ensureMergeableText(TEXT_KEY);
      if (domNode.data.length > 0) text.insert(0, domNode.data);
    }
  }

  private walkDom(): SupportedNode[] {
    const result: SupportedNode[] = [];
    const visit = (parent: Node) => {
      for (const child of supportedChildren(parent)) {
        result.push(child);
        if (isElement(child)) visit(child);
      }
    };
    visit(this.root);
    return result;
  }

  private syncNodeStateToCrdt(domNode: SupportedNode): void {
    const id = this.domToId.get(domNode);
    const crdtNode = id ? this.tree.getNodeByID(id) : undefined;
    if (!crdtNode || crdtNode.isDeleted()) return;

    if (isElement(domNode)) {
      const attributes = crdtNode.data.get(ATTRIBUTES_KEY);
      if (attributes instanceof LoroMap) this.syncAttributesToCrdt(domNode, attributes);
      return;
    }

    const text = crdtNode.data.get(TEXT_KEY);
    if (text instanceof LoroText) this.updateCrdtText(text, domNode.data);
  }

  private syncAttributesToCrdt(element: Element, attributes: LoroMap): void {
    const desired = new Map<string, string | AttributeState>();
    for (const attribute of Array.from(element.attributes)) {
      desired.set(attributeKey(attribute.namespaceURI, attribute.localName), encodeAttribute(attribute));
    }

    const current = attributes.getShallowValue();
    for (const key of Object.keys(current)) {
      if (!desired.has(key)) attributes.delete(key);
    }
    for (const [key, value] of desired) {
      if (JSON.stringify(current[key]) !== JSON.stringify(value)) attributes.set(key, value);
    }
  }

  private updateCrdtText(text: LoroText, after: string): void {
    const before = text.toString();
    if (before === after) return;

    const { prefix, suffix } = commonAffixes(before, after);
    const deleteLength = before.length - prefix - suffix;
    const insertion = after.slice(prefix, after.length - suffix);
    if (deleteLength > 0) text.delete(prefix, deleteLength);
    if (insertion.length > 0) text.insert(prefix, insertion);
  }

  private projectFromCrdt(): void {
    const rootNode = this.tree.getNodeByID(this.rootId);
    if (!rootNode || rootNode.isDeleted() || rootNode.data.get("type") !== ROOT_KIND) {
      throw new Error("The fixed DOM CRDT root was deleted or corrupted");
    }

    this.bind(this.rootId, this.root);
    const liveIds = new Set<TreeID>([this.rootId]);
    this.projectChildren(rootNode, this.root, liveIds);

    for (const [id, domNode] of Array.from(this.idToDom.entries())) {
      if (liveIds.has(id)) continue;
      if (domNode !== this.root) domNode.parentNode?.removeChild(domNode);
      this.unbind(id);
    }

    this.removeUnmappedSupportedChildren(this.root, liveIds);
  }

  private projectChildren(
    crdtParent: LoroTreeNode,
    domParent: Node,
    liveIds: Set<TreeID>,
  ): void {
    const desiredCrdtChildren = directCrdtChildren(crdtParent).filter((node) => !node.isDeleted());
    let cursor = supportedChildren(domParent)[0] ?? null;

    for (const crdtChild of desiredCrdtChildren) {
      liveIds.add(crdtChild.id);
      let domChild = this.idToDom.get(crdtChild.id) as SupportedNode | undefined;
      if (!domChild) {
        domChild = this.createDomNode(crdtChild);
        this.bind(crdtChild.id, domChild);
      }

      if (domChild !== cursor) domParent.insertBefore(domChild, cursor);
      cursor = this.nextSupportedSibling(domChild);

      this.projectNodeState(crdtChild, domChild);
      if (isElement(domChild)) this.projectChildren(crdtChild, domChild, liveIds);
    }
  }

  private createDomNode(crdtNode: LoroTreeNode): SupportedNode {
    const type = crdtNode.data.get("type");
    if (type === TEXT_KIND) return this.root.ownerDocument.createTextNode("");
    if (type !== ELEMENT_KIND) throw new Error(`Unsupported CRDT DOM node type: ${String(type)}`);

    const namespaceValue = crdtNode.data.get("namespaceURI");
    const namespaceURI = typeof namespaceValue === "string" ? namespaceValue : null;
    const localName = this.readElementLocalName(crdtNode);
    if (!localName) throw new Error("CRDT element is missing localName metadata");
    return this.root.ownerDocument.createElementNS(namespaceURI, localName);
  }

  private projectNodeState(
    crdtNode: LoroTreeNode,
    domNode: SupportedNode,
  ): void {
    const type = crdtNode.data.get("type");
    if (type === TEXT_KIND && domNode.nodeType === TEXT_NODE) {
      const text = crdtNode.data.get(TEXT_KEY);
      const value = text instanceof LoroText ? text.toString() : "";
      if ((domNode as Text).data !== value) (domNode as Text).data = value;
      return;
    }

    if (type === ELEMENT_KIND && isElement(domNode)) {
      const attributes = crdtNode.data.get(ATTRIBUTES_KEY);
      this.projectAttributes(domNode, attributes instanceof LoroMap ? attributes : undefined);
      return;
    }

    throw new Error(`DOM node #${crdtNode.id} no longer matches its immutable CRDT type`);
  }

  private projectAttributes(element: Element, attributes?: LoroMap): void {
    const desired = new Map<string, AttributeState>();
    for (const [key, value] of Object.entries(attributes?.getShallowValue() ?? {})) {
      const decoded = decodeAttribute(key, value);
      if (decoded) desired.set(attributeKey(decoded.namespaceURI, decoded.localName), decoded);
    }

    for (const attribute of Array.from(element.attributes)) {
      const key = attributeKey(attribute.namespaceURI, attribute.localName);
      if (desired.has(key)) continue;
      if (attribute.namespaceURI === null) element.removeAttribute(attribute.name);
      else element.removeAttributeNS(attribute.namespaceURI, attribute.localName);
    }

    for (const attribute of desired.values()) {
      const current = attribute.namespaceURI === null
        ? element.getAttribute(attribute.name)
        : element.getAttributeNS(attribute.namespaceURI, attribute.localName);
      if (current === attribute.value) continue;
      if (attribute.namespaceURI === null) element.setAttribute(attribute.name, attribute.value);
      else element.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
    }
  }

  private nextSupportedSibling(node: Node): SupportedNode | null {
    let sibling = node.nextSibling;
    while (sibling && !isSupportedNode(sibling)) sibling = sibling.nextSibling;
    return sibling;
  }

  private removeUnmappedSupportedChildren(parent: Node, liveIds: Set<TreeID>): void {
    for (const child of supportedChildren(parent)) {
      const id = this.domToId.get(child);
      if (!id || !liveIds.has(id)) {
        child.parentNode?.removeChild(child);
        continue;
      }
      if (isElement(child)) this.removeUnmappedSupportedChildren(child, liveIds);
    }
  }

  private dumpNode(
    node: LoroTreeNode,
    prefix: string,
    isLast: boolean,
    lines: string[],
  ): void {
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = `${prefix}${isLast ? "    " : "│   "}`;
    const type = node.data.get("type");
    if (type === TEXT_KIND) {
      const text = node.data.get(TEXT_KEY);
      lines.push(`${prefix}${connector}#text #${node.id} ${JSON.stringify(text instanceof LoroText ? text.toString() : "")}`);
      return;
    }

    const attributes = node.data.get(ATTRIBUTES_KEY);
    const decodedAttributes = Object.entries(
      attributes instanceof LoroMap ? attributes.getShallowValue() : {},
    ).flatMap(([key, value]) => {
      const decoded = decodeAttribute(key, value);
      return decoded ? [decoded] : [];
    });
    const localName = this.readElementLocalName(node) ?? "?";
    lines.push(`${prefix}${connector}${localName} #${node.id}`);
    for (const attribute of decodedAttributes) {
      lines.push(`${childPrefix}@${attribute.name}=${JSON.stringify(attribute.value)}`);
    }

    const children = directCrdtChildren(node).filter((child) => !child.isDeleted());
    children.forEach((child, index) => {
      this.dumpNode(child, childPrefix, index === children.length - 1, lines);
    });
  }
}

export function createDomCrdt(options: CreateDomCrdtOptions): DomCrdtSync {
  return new DomCrdtSyncImpl(options);
}

export function attachDom(root: Element, doc: LoroDoc): DomCrdtSync {
  return createDomCrdt({ root, doc });
}

export { LoroDoc } from "loro-crdt";
export type { TreeID, VersionVector } from "loro-crdt";
