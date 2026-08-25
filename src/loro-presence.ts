import { Cursor, LoroText, type TreeID } from "loro-crdt";
import type { DomCrdtSync } from "./dom-crdt.ts";
import type { PresencePointAdapter } from "./dom-presence.ts";

export type PresencePoint =
  | {
    kind: "text";
    nodeId: TreeID;
    cursor: Uint8Array;
  }
  | {
    kind: "boundary";
    parentId: TreeID;
    beforeChildId?: TreeID;
  };

/** The only package-specific bridge between DOM endpoints and Loro positions. */
export function createDomCrdtPresencePointAdapter(
  sync: Pick<DomCrdtSync, "doc" | "getCrdtNode" | "getDomNode">,
): PresencePointAdapter<PresencePoint> {
  const tree = sync.doc.getTree("dom");
  const getText = (nodeId: TreeID): LoroText | undefined => {
    const text = tree.getNodeByID(nodeId)?.data.get("text");
    return text instanceof LoroText ? text : undefined;
  };

  return {
    capture(node, offset) {
      if (node.nodeType === 3) {
        const nodeId = sync.getCrdtNode(node);
        const text = nodeId ? getText(nodeId) : undefined;
        if (!nodeId || !text) return undefined;

        const safeOffset = Math.max(0, Math.min(Math.floor(offset), (node as Text).data.length));
        const cursor = text.getCursor(safeOffset, 0);
        if (!cursor) return undefined;
        try {
          return { kind: "text", nodeId, cursor: cursor.encode() };
        } finally {
          cursor.free();
        }
      }

      if (node.nodeType !== 1) return undefined;
      const parentId = sync.getCrdtNode(node);
      if (!parentId) return undefined;
      const safeOffset = Math.max(0, Math.min(Math.floor(offset), node.childNodes.length));
      for (let index = safeOffset; index < node.childNodes.length; index += 1) {
        const child = node.childNodes[index];
        const beforeChildId = child ? sync.getCrdtNode(child) : undefined;
        if (beforeChildId) return { kind: "boundary", parentId, beforeChildId };
      }
      return { kind: "boundary", parentId };
    },

    resolve(point) {
      if (point.kind === "boundary") {
        const parent = sync.getDomNode(point.parentId);
        if (!parent || parent.nodeType !== 1) return undefined;
        const before = point.beforeChildId ? sync.getDomNode(point.beforeChildId) : undefined;
        const offset = before?.parentNode === parent
          ? Array.prototype.indexOf.call(parent.childNodes, before) as number
          : parent.childNodes.length;
        return { node: parent, offset };
      }

      const node = sync.getDomNode(point.nodeId);
      const text = getText(point.nodeId);
      if (!node || node.nodeType !== 3 || !text || !(point.cursor instanceof Uint8Array)) {
        return undefined;
      }

      let cursor: Cursor | undefined;
      let updatedCursor: Cursor | undefined;
      try {
        cursor = Cursor.decode(point.cursor);
        if (cursor.containerId() !== text.id) return undefined;
        const position = sync.doc.getCursorPos(cursor);
        updatedCursor = position?.update;
        if (!position) return undefined;
        return {
          node,
          offset: Math.max(0, Math.min(position.offset, (node as Text).data.length)),
        };
      } catch {
        return undefined;
      } finally {
        updatedCursor?.free();
        cursor?.free();
      }
    },
  };
}
