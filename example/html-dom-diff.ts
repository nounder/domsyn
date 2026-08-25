const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;
const DEFAULT_KEY_ATTRIBUTES = ["id", "data-key", "data-task"] as const;
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const WHITESPACE_SENSITIVE_ELEMENTS = new Set(["pre", "script", "style", "textarea"]);

export interface HtmlDomDiffResult {
  created: number;
  removed: number;
  moved: number;
  text: number;
  attributes: number;
}

export interface HtmlDomDiffOptions {
  getKey?: (element: Element) => string | undefined;
  ignoreFormattingWhitespace?: boolean;
}

function defaultKey(element: Element): string | undefined {
  for (const name of DEFAULT_KEY_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value) return `${name}:${value}`;
  }
  return undefined;
}

function nodeKey(node: Node, getKey: (element: Element) => string | undefined): string | undefined {
  return node.nodeType === ELEMENT_NODE ? getKey(node as Element) : undefined;
}

function sameNodeKind(current: Node, desired: Node): boolean {
  if (current.nodeType !== desired.nodeType) return false;
  if (current.nodeType !== ELEMENT_NODE) {
    return current.nodeType === TEXT_NODE || current.nodeType === COMMENT_NODE;
  }

  const currentElement = current as Element;
  const desiredElement = desired as Element;
  return currentElement.namespaceURI === desiredElement.namespaceURI &&
    currentElement.localName === desiredElement.localName;
}

function canReuse(
  current: Node,
  desired: Node,
  getKey: (element: Element) => string | undefined,
): boolean {
  if (!sameNodeKind(current, desired)) return false;
  if (current.nodeType !== ELEMENT_NODE) return true;
  const currentKey = getKey(current as Element);
  const desiredKey = getKey(desired as Element);
  return currentKey === undefined && desiredKey === undefined || currentKey === desiredKey;
}

function equalNode(current: Node, desired: Node): boolean {
  return current.isEqualNode(desired);
}

function findSibling(
  start: Node | null,
  predicate: (node: Node) => boolean,
): Node | undefined {
  for (let node = start; node; node = node.nextSibling) {
    if (predicate(node)) return node;
  }
  return undefined;
}

function countNodes(node: Node): number {
  let count = 1;
  for (const child of Array.from(node.childNodes)) count += countNodes(child);
  return count;
}

function isHtmlElement(node: Node | null, names: Set<string>): boolean {
  return node?.nodeType === ELEMENT_NODE &&
    (node as Element).namespaceURI === HTML_NAMESPACE &&
    names.has((node as Element).localName);
}

function normalizeFormattingWhitespace(parent: Node): void {
  if (isHtmlElement(parent, WHITESPACE_SENSITIVE_ELEMENTS)) return;

  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === ELEMENT_NODE) normalizeFormattingWhitespace(child);
  }

  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType !== TEXT_NODE || !child.nodeValue?.includes("\n")) continue;

    // Markup formatters introduce indentation both between elements and around
    // text when an opening tag spans multiple lines. In ordinary HTML those
    // line breaks are presentation whitespace, so collapse internal breaks and
    // remove boundary breaks before comparing with the live DOM.
    const normalized = child.nodeValue
      .replace(/^[\t ]*\r?\n[\t ]*/, "")
      .replace(/[\t ]*\r?\n[\t ]*$/, "")
      .replace(/[\t ]*\r?\n[\t ]*/g, " ");
    if (normalized === "") parent.removeChild(child);
    else if (normalized !== child.nodeValue) child.nodeValue = normalized;
  }
}

function attributeSlot(attribute: Attr): string {
  return `${attribute.namespaceURI ?? ""}\u0000${attribute.localName}`;
}

function reconcileAttributes(
  current: Element,
  desired: Element,
  result: HtmlDomDiffResult,
): void {
  const desiredAttributes = new Map(
    Array.from(desired.attributes, (attribute) => [attributeSlot(attribute), attribute] as const),
  );

  for (const attribute of Array.from(current.attributes)) {
    if (desiredAttributes.has(attributeSlot(attribute))) continue;
    if (attribute.namespaceURI === null) current.removeAttribute(attribute.name);
    else current.removeAttributeNS(attribute.namespaceURI, attribute.localName);
    result.attributes += 1;
  }

  for (const attribute of desiredAttributes.values()) {
    const value = attribute.namespaceURI === null
      ? current.getAttribute(attribute.name)
      : current.getAttributeNS(attribute.namespaceURI, attribute.localName);
    if (value === attribute.value) continue;
    if (attribute.namespaceURI === null) current.setAttribute(attribute.name, attribute.value);
    else current.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
    result.attributes += 1;
  }
}

function reconcileNode(
  current: Node,
  desired: Node,
  result: HtmlDomDiffResult,
  getKey: (element: Element) => string | undefined,
): void {
  if (current.nodeType === TEXT_NODE || current.nodeType === COMMENT_NODE) {
    if (current.nodeValue !== desired.nodeValue) {
      current.nodeValue = desired.nodeValue;
      result.text += 1;
    }
    return;
  }

  if (current.nodeType !== ELEMENT_NODE) return;
  const currentElement = current as Element;
  const desiredElement = desired as Element;
  reconcileAttributes(currentElement, desiredElement, result);
  reconcileChildren(currentElement, desiredElement, result, getKey);
}

function reconcileChildren(
  currentParent: Node,
  desiredParent: Node,
  result: HtmlDomDiffResult,
  getKey: (element: Element) => string | undefined,
): void {
  const desiredChildren = Array.from(desiredParent.childNodes);
  let cursor = currentParent.firstChild;

  for (let index = 0; index < desiredChildren.length; index += 1) {
    const desired = desiredChildren[index]!;
    const desiredKey = nodeKey(desired, getKey);
    let candidate: Node | undefined;

    if (desiredKey !== undefined) {
      candidate = findSibling(cursor, (node) =>
        nodeKey(node, getKey) === desiredKey && canReuse(node, desired, getKey)
      );
    } else if (cursor && canReuse(cursor, desired, getKey)) {
      if (equalNode(cursor, desired)) {
        candidate = cursor;
      } else {
        const exactLater = findSibling(cursor.nextSibling, (node) =>
          canReuse(node, desired, getKey) && equalNode(node, desired)
        );
        const cursorAppearsLater = desiredChildren.slice(index + 1).some((future) =>
          canReuse(cursor!, future, getKey) && equalNode(cursor!, future)
        );
        candidate = exactLater ?? (cursorAppearsLater ? undefined : cursor);
      }
    } else {
      candidate = findSibling(cursor, (node) =>
        canReuse(node, desired, getKey) && equalNode(node, desired)
      ) ?? findSibling(cursor, (node) => canReuse(node, desired, getKey));
    }

    if (!candidate && cursor && sameNodeKind(cursor, desired)) {
      const currentKey = nodeKey(cursor, getKey);
      const cursorAppearsLater = desiredChildren.slice(index + 1).some((future) =>
        currentKey === undefined
          ? sameNodeKind(cursor!, future) && equalNode(cursor!, future)
          : nodeKey(future, getKey) === currentKey && sameNodeKind(cursor!, future)
      );
      if (!cursorAppearsLater) candidate = cursor;
    }

    let placed: Node;
    if (candidate) {
      if (candidate !== cursor) {
        currentParent.insertBefore(candidate, cursor);
        result.moved += 1;
      }
      reconcileNode(candidate, desired, result, getKey);
      placed = candidate;
    } else {
      placed = desired.cloneNode(true);
      currentParent.insertBefore(placed, cursor);
      result.created += countNodes(placed);
    }

    cursor = placed.nextSibling;
  }

  while (cursor) {
    const next = cursor.nextSibling;
    result.removed += countNodes(cursor);
    currentParent.removeChild(cursor);
    cursor = next;
  }
}

/**
 * Parses an HTML fragment and incrementally reconciles it into `root`.
 * Compatible nodes are updated or moved in place so DOM identity, listeners,
 * and the corresponding CRDT tree IDs survive filesystem edits.
 */
export function applyHtmlDomDiff(
  root: Element,
  html: string,
  options: HtmlDomDiffOptions = {},
): HtmlDomDiffResult {
  const template = root.ownerDocument.createElement("template");
  template.innerHTML = html;
  if (options.ignoreFormattingWhitespace) normalizeFormattingWhitespace(template.content);
  const result: HtmlDomDiffResult = {
    created: 0,
    removed: 0,
    moved: 0,
    text: 0,
    attributes: 0,
  };
  reconcileChildren(root, template.content, result, options.getKey ?? defaultKey);
  return result;
}
