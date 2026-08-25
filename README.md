# domsyn

A working prototype that makes a live browser DOM subtree collaborative with
[Loro](https://www.loro.dev/docs/tutorial/tree). The Loro movable tree is the canonical structure; the browser DOM is
an identity-preserving projection and a local mutation interface.

There is no HTML-string synchronization. The library never reads `innerHTML`, writes `innerHTML`, invokes a parser, or
uses a serialized DOM path as identity. (`innerHTML` appears only in test fixture setup.)

## Try it

```sh
bun install
bun run dev
```

Open `http://localhost:3000`. The server redirects through `/spaces` to `/spaces/:uuid`. Each space uses a
`BroadcastChannel` named from that ID and stores Loro snapshot bytes in `localStorage`, so the space retains the same
CRDT identity graph when reopened.

Each tab renders one plain document: editable heading and body text, plus a draggable, editable list. A fixed sidebar
shows the current CRDT identity tree, raw Loro state, and every local/import/network event as it streams. Open the exact
same `/spaces/:uuid` URL in another tab to create an independent `LoroDoc` replica; tabs hydrate from the stored snapshot
and exchange update bytes through a hello/full-update `BroadcastChannel` handshake.

## API

```ts
import { createDomCrdt, LoroDoc } from "domsyn"

const sync = createDomCrdt({
  root: document.querySelector("#root")!,
  doc: new LoroDoc(), // optional; a new document is the default
})

const stopSending = sync.onUpdate((bytes) => network.send(bytes))
network.onMessage((bytes) => sync.applyUpdate(bytes))

sync.flush() // synchronously consume pending observer records when needed
sync.getUpdate()
sync.getSnapshot()
sync.getCrdtNode(someDomNode)
sync.getDomNode(treeId)
console.log(sync.dumpTree())

stopSending()
sync.destroy()
```

If the supplied document's `dom` tree is empty, `createDomCrdt` walks the existing DOM and imports it through DOM APIs.
If the tree already exists, it hydrates the supplied root from the CRDT. `attachDom(root, doc)` is a convenience alias
for the latter form.

### Presence

Presence is a separate ephemeral pipeline. It is never written to `LoroDoc`, so it cannot enter update bytes,
snapshots, persisted state, or history. The small state store only handles sequencing, heartbeats, expiry, and transport;
the DOM controller only handles selection capture and rendering. They are connected by a point adapter, so neither
piece depends on BroadcastChannel or the DOM CRDT implementation.

```ts
import {
  createDomCrdtPresencePointAdapter,
  createDomPresence,
  createPresenceStore,
  type PresencePoint,
} from "domsyn"

const store = createPresenceStore<PresencePoint>({
  peerId,
  name,
  color,
  send: (presence) => network.send({ kind: "presence", presence }),
})

const presence = createDomPresence({
  root,
  layer: document.querySelector("#presence-layer")!, // outside root
  store,
  pointAdapter: createDomCrdtPresencePointAdapter(sync),
  beforeCapture: () => sync.flush(),
})

network.onPresence((remote) => store.receive(remote))
network.onGoodbye((peerId) => store.remove(peerId))
```

`createPresenceStore` and `createDomPresence` are reusable independently. Only
`createDomCrdtPresencePointAdapter(sync)` knows about this package's Loro tree/text schema. Local selection messages are
coalesced to one per animation frame. Remote ranges use CSS Highlights; carets and labels live in the external overlay.
The overlay refreshes after presence changes, DOM mutations, scrolling, resizing, and `ResizeObserver` notifications.
The default heartbeat is 3 seconds and inactive remote presence expires after 10 seconds.

## Model

The Loro tree has one synthetic, immutable synchronization root. It maps to the supplied DOM root but does not describe
that element. Consequently, children below the supplied root are synchronized; the root element's own attributes are
not.

Each synchronized `Element` or `Text` is exactly one Loro movable-tree node:

```text
LoroTree "dom"
└── fixed synthetic root
    └── movable node
        ├── node.data: LoroMap
        ├── attributes: mergeable LoroMap
        └── text: mergeable LoroText (text nodes only)
```

Element metadata stores `namespaceURI` and `localName`. Ordinary non-namespaced attributes use their DOM-provided name
directly as the Loro map key (`class → "drag-handle"`), which naturally preserves SVG casing such as `viewBox`. Only
genuinely namespaced attributes use an encoded `(namespaceURI, localName)` key and retain the qualified name needed by
`setAttributeNS`. Attribute slots have Loro map LWW semantics.

Identity is only the Loro `TreeID`. Runtime correspondence is maintained by:

```ts
Map<TreeID, Node>
WeakMap<Node, TreeID>
```

DOM position is consulted only to issue a Loro `tree.move(id, parentId, index)` operation. It never determines an ID.
A remote move calls `insertBefore` with the mapped existing DOM object, preserving listeners, custom-element state, form
state, arbitrary properties, and references held elsewhere.

## Mutation and projection behavior

One `MutationObserver` delivery is one Loro transaction. The translator examines the final DOM after the complete batch:

1. unknown live nodes are created in preorder so parents receive identities first;
2. known nodes that escaped a soon-to-be-deleted subtree are moved out first;
3. genuinely absent nodes are tombstoned with Loro tree deletion;
4. live parent/order mismatches become Loro tree moves;
5. final attributes and character data are coalesced into map/text operations.

Text changes use a common-prefix/common-suffix delta against the current `LoroText`, producing only the necessary delete
and insert. Concurrent edits therefore merge as text operations instead of competing whole-string assignments.

CRDT-to-DOM projection scans the identity tree but mutates only differences. It creates missing nodes with
`createElementNS`/`createTextNode`, moves mapped nodes with `insertBefore`, changes attributes individually, updates
`Text.data`, and removes deleted objects. It does not rebuild the root.

### Feedback suppression

A synchronous boolean is insufficient because `MutationObserver` delivery is asynchronous. Before applying an update,
the implementation consumes pending local observer records. It then disconnects the observer, imports and projects the
remote transaction, discards any implementation-specific queued records, and reconnects with the same options. Real
browser tests verify that a remote update emits no local Loro update.

## Verified concurrency semantics

The tests use two independent replicas, mutate both through ordinary DOM calls, exchange Loro updates, and compare the
resulting DOM and identity trees.

- Concurrent text edits in different regions survive through `LoroText`.
- Concurrent inserts and reorders converge using Loro's fractional sibling ordering.
- A move concurrent with a descendant text edit preserves the same tree node and the edit.
- Concurrent moves of one node converge to one parent under Loro's globally ordered move semantics; no copy is made.
- A deleted subtree remains absent after a concurrent descendant edit. Loro retains the descendant text edit in the
  tombstoned node's history, which the test also verifies.
- Same-attribute conflicts converge with Loro map last-write-wins semantics (Lamport ordering).
- Potential cycles from concurrent tree operations are handled by Loro's movable-tree algorithm rather than custom DOM
  rules.

See [Loro's tree documentation](https://www.loro.dev/docs/tutorial/tree),
[movable-tree algorithm discussion](https://www.loro.dev/blog/movable-tree), and
[map conflict semantics](https://www.loro.dev/docs/tutorial/map).

## Tests

```sh
bun run browser:install # once: installs Chromium for Playwright
bun test
bun run typecheck
```

The suite currently covers DOM creation, recursive subtree import, removal, replacement, move/reparent, reorder, deep
moves, attributes, CRDT text deltas, concurrent edits/inserts/moves/reorders/deletion, custom elements, SVG and xlink
namespaces, batched synchronous mutations, hydration, debug identities, instance preservation, and observer-loop
suppression. `tests/browser.test.ts` opens multiple real Chromium tabs on one space and verifies live text/list sync,
CRDT-relative caret preservation, identity-preserving reorder, the event stream, and late-tab hydration. The remaining
fast tests use independent Happy DOM windows.

## Scope and limitations

- Supported: `Element`, `Text`, light DOM, custom elements, attributes, namespaces, arbitrary browser-permitted tree
  structure.
- Ignored: comments, doctypes, processing instructions, shadow roots, iframe contents, event listeners, JS properties,
  arbitrary application state, and semantic HTML validity.
- A local selection inside the synchronized root is preserved across remote projection with Loro text cursors. Selection
  state can also be broadcast through the optional ephemeral presence modules described above.
- Attributes synchronize; properties do not. `input.setAttribute("value", "x")` is in scope, while `input.value = "x"`
  is not guaranteed to produce an observable mutation.
- The supplied root is fixed and cannot be moved or deleted through this API. Its children are the collaborative
  subtree.
- Remote reconciliation is identity-incremental but currently scans the synchronized tree. This favors correctness over
  large-tree performance for the prototype.

## Result

For this scope, Loro's movable tree, mergeable maps/text, and `MutationObserver` are sufficient to use the browser DOM as
a generic collaborative document model. The important caveat is that the binding must reconcile observer batches by
stable identity and must suppress asynchronous observer feedback explicitly; treating moves as record-by-record
remove/add operations would break the result.
