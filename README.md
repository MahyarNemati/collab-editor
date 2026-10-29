# collab-editor

[![CI](https://github.com/MahyarNemati/collab-editor/actions/workflows/ci.yml/badge.svg)](https://github.com/MahyarNemati/collab-editor/actions/workflows/ci.yml)

A real-time collaborative text editor: **Yjs CRDTs over WebSockets, offline-first**,
in TypeScript. Open two tabs on the same document and they converge. Pull the
network, keep typing, reload the page, come back — nothing is lost.

The editor widget is the least interesting part. What this repository is actually
about is everything around the CRDT: **persisting an update stream without
letting it grow forever**, keeping **presence ephemeral** so it cannot leave
ghosts, making **offline the normal case** rather than an error path, and being
honest about what per-document authorisation can and cannot do when **the thing
being authorised is opaque to the server**.

```
                      ┌──────────────────────────────────────────────┐
  browser tab A       │  CodeMirror 6  ◄──── binding ────►  Y.Text   │
                      │       ▲                                │     │
                      │       │ remote carets                  │     │
                      │  Awareness (ephemeral)            Y.Doc│     │
                      │       │                                │     │
                      │       └──────► WebSocketProvider ◄──────┘     │
                      │                      │       ▲               │
                      │                      │       └── IndexedDB   │
                      └──────────────────────┼───────────────────────┘
                                             │
                      binary frames: AUTH | SYNC_STEP1 | SYNC_STEP2
                                   | UPDATE | AWARENESS | ERROR
                                             │
   ┌─────────────────────────────────────────▼─────────────────────────────┐
   │  Node WebSocket server                                               │
   │                                                                      │
   │  Connection                   Room (one per document)                │
   │  ├─ HMAC token → role         ├─ Y.Doc           (authoritative)     │
   │  ├─ token bucket (inbound)    ├─ Awareness       (never persisted)   │
   │  └─ backpressure (outbound)   ├─ presence sweeper                    │
   │     awareness droppable,      └─ coalescing flush ──┐                │
   │     updates are not                                 │                │
   └─────────────────────────────────────────────────────┼────────────────┘
                                                         ▼
                               FileStore: append-only update log per document
                               data/<doc>.ylog = [u32 len][update] …
                               compacted in place with Y.mergeUpdates
```

---

## Quickstart

```bash
npm install
npm run dev
```

`npm run dev` brings up both halves: the WebSocket server on `:1234` and the
Vite client on `:5173`, which proxies `/ws` and `/api` to the server so there is
a single origin and nothing to configure. Open <http://127.0.0.1:5173>.

You get two panes side by side. They are **two genuinely independent clients** —
separate `Y.Doc`s, separate client ids, separate IndexedDB databases, separate
WebSocket connections — so the convergence you see is the real thing and not two
views of one in-memory document.

Things worth trying:

| Try this | What it demonstrates |
|---|---|
| Type in both panes at once | Concurrent merge, remote carets, presence names |
| **Go offline** on one pane, keep typing | Local-first editing with no connection |
| Reload the page while a pane is offline | IndexedDB persistence — the offline flag survives too, so the text you see came from local storage, not the server |
| Take **both** panes offline, edit the same word in each, bring both back | Three-way merge where neither side's intent is thrown away |
| Open a third pane: `?panes=3` | `?doc=<name>` picks the document, `?as=<name>` sets the identity |
| Stop the server, restart it | The document comes back from `data/<doc>.ylog` |

```bash
npm test          # 87 unit, convergence, property and integration tests
npm run test:e2e  # 4 Playwright tests in real browsers
npm run build     # client → dist/client, server → dist/server
npm start         # one process serving both
```

With Docker:

```bash
docker compose up --build   # http://127.0.0.1:1234
```

---

## Why a Vite client and a plain Node server (and not Next.js)

Next.js App Router is the better default for most of this stack, and it is the
wrong fit here for two concrete reasons:

1. **The server is a long-lived stateful process, not a request handler.** It
   holds one `Y.Doc` and one awareness map per open document, with timers for
   presence expiry and persistence flushing, and it has to outlive every
   request. That is not what a route handler is, and hosting it inside one means
   fighting the framework's process model.
2. **There is nothing to render on the server.** The editor's initial content
   comes from IndexedDB before the socket even opens, precisely so a reload is
   instant and works offline. Server-rendering a document that the client is
   about to replace from local storage adds a hydration mismatch and buys
   nothing.

So: Vite for the client (fast, zero-config, builds to static files) and a bare
`ws` server. In production a single Node process serves both, which is what the
`Dockerfile` does.

---

## Persistence: an update log that gets compacted

The server stores the **Yjs update stream**, not snapshots:

```
data/<docId>.ylog
  [uint32be length][update bytes]
  [uint32be length][update bytes]
  …
```

Length-prefixed rather than delimited, because a Yjs update is arbitrary binary
and contains every possible byte — there is no safe delimiter.

Storing updates rather than snapshots means the server never has to re-serialise
the whole document to record a keystroke, and it keeps the ability to answer
*"what changed since state vector X"* — which is the entire reconnect path.

**An append-only log of keystrokes grows without bound, and that is the standard
first mistake.** A 2,000-word document typed one character at a time is ~10,000
frames, most of which are superseded. So the log is compacted: once it passes
`COLLAB_COMPACT_AFTER_FRAMES` frames or `COLLAB_COMPACT_AFTER_BYTES` bytes, every
frame is merged with `Y.mergeUpdates` into a single frame and the file is
rewritten through a temp file and `rename`, which is atomic within a directory.
`Y.mergeUpdates` is lossless — [a test asserts that a compacted log and the raw
log produce byte-identical replicas](test/crdt/convergence.test.ts).

Two more things the implementation gets right and are easy to get wrong:

- **Writes are coalesced before they are appended.** A burst of keystrokes is
  dozens of tiny updates; the room buffers them for
  `COLLAB_PERSIST_FLUSH_MS` and appends one merged frame. Fewer syscalls, and far
  fewer frames for compaction to collapse later.
- **A torn final frame does not break the document.** A process killed
  mid-append leaves a length header promising bytes that are not there. `load()`
  stops at the first incomplete frame instead of throwing: losing the last
  keystroke of a crashed process is acceptable, refusing to open the document is
  not. [Tested by writing a torn frame on purpose.](test/server/store.test.ts)

**Durability trade-off, stated plainly:** appends are not `fsync`ed. A host
crash — not a process crash — can lose up to one flush interval of edits.
`fsync` per keystroke would cost a disk round-trip per character. Compaction
*does* sync before the rename, because a torn compaction would lose the whole
document rather than one keystroke. If you need stricter durability, the knob is
`COLLAB_PERSIST_FLUSH_MS=0` plus an `fsync` in `FileStore.append` — and you
should expect to feel it.

---

## Presence: ephemeral on purpose

Remote cursors and selections ride the `y-protocols/awareness` channel. Two
rules, both of which are load-bearing:

**Presence is never written to the store.** It is tempting — it is just another
update stream — and it is wrong. Presence describes a *live connection*, so a
persisted cursor is a cursor belonging to somebody who left, and it reappears on
every load as a ghost. [A test asserts that a presence-only session leaves the
store completely empty and that reopening the document yields zero awareness
states.](test/server/room.test.ts)

**Stale peers expire.** A clean disconnect removes presence via the socket close
handler. The unclean ones — a killed tab, a mobile radio dropping — never say
goodbye, so the room sweeps peers whose last awareness update is older than
`COLLAB_PRESENCE_TIMEOUT_MS` and broadcasts the removal. Clients refresh their
own state on a heartbeat so an idle-but-present peer is not swept. There is [an
integration test that keeps the socket open, stops sending awareness, and
asserts the peer disappears from the other browser while the document
connection keeps working](test/server/websocket.test.ts).

One small hardening worth naming: a connection may only move awareness client
ids it has claimed, and may claim at most four. Without that, any peer can
puppet another peer's caret, or flood the room with thousands of fake cursors.

---

## Offline-first: the queue that is not a queue

The provider has **no outbound queue of unsent updates**, and that is the most
interesting design decision in the client.

The obvious offline-first design is a FIFO of pending updates, replayed on
reconnect. With a CRDT that queue is redundant and strictly worse, because **the
local `Y.Doc` is already the queue**. Every edit made while disconnected is in
it. On reconnect the two sides exchange state vectors — *"here is everything I
have"* — and each sends exactly the delta the other is missing.

A replay queue would additionally have to survive a reload, be deduplicated
against whatever the server already saw, and be ordered. The state-vector
handshake needs none of that: it is idempotent, it is correct if frames arrive
twice or out of order, and it costs one round trip whether the client was away
for a second or a week.

What *does* need writing is everything around it, and it is all in
[`src/client/src/provider.ts`](src/client/src/provider.ts):

- reconnect with exponential backoff and **full jitter**, so a server restart
  does not produce a thundering herd on the same tick;
- **clearing remote presence the moment the socket drops** — once the link is
  gone the client knows nothing about the other editors, and leaving their
  carets on screen is a lie that gets worse with time;
- a presence heartbeat;
- respecting the role the server reported: a read-only client declines to
  *send*, because a `Y.Doc` cannot be made to decline an *edit*.

Durability on the client is `y-indexeddb`, loaded before the socket opens, so a
reload shows your own text immediately rather than after a round trip.

---

## Authorisation and the opaque-update problem

Access is per document. A token is `base64url(claims).base64url(hmac-sha256)`
carrying `{ doc, sub, role, exp }`, with `role` either `read` or `write`. It
travels in the **first WebSocket frame, not in the URL**, so it does not end up
in access logs, proxy logs or browser history.

Then comes the hard part.

**A CRDT update is opaque. The server cannot validate its contents.** It is a
binary encoding of structs and a delete set, addressed by client id and clock.
There is no "this update sets field X to Y" to inspect, no schema to check it
against, and — importantly — no way to partially accept it. The server is a
relay with a copy of the document, not a validator.

What follows from that, honestly:

- **A client with write access can write anything.** It can replace the whole
  text, delete everything, or insert structure the application does not expect
  (a `Y.Map` where a `Y.Text` was, deeply nested types, a million tiny items).
  Write access to a CRDT document is closer to `UPDATE table SET blob = ?` than
  to a typed API call.
- **Authorisation is all-or-nothing per document.** There is no "may edit
  paragraph 3". Region-level permissions in a CRDT are an open research problem,
  not a configuration option.
- **Vandalism is a product problem, not a transport one.** The answer is version
  history and the ability to roll back, not validation at the socket.

What this server *does* do about it, all of it tested:

| Mitigation | Why it is possible despite opacity |
|---|---|
| **Decode-validate** every update with `Y.decodeUpdate` before applying | Structural well-formedness *is* checkable, so random or truncated bytes are rejected rather than applied |
| **Per-update size cap** (`256 KiB`) and **frame cap** (`512 KiB`) | Bounds the work one frame can cost, without needing to understand it |
| **Per-document quota** (`COLLAB_MAX_DOC_BYTES`) | Caps total accepted update bytes, so one writer cannot grow a document until the host runs out of memory. Deliberately an over-estimate of real size — it can refuse slightly early, never late |
| **Inbound token bucket** per connection | A write-authorised client still cannot monopolise the event loop |
| **Role enforced server-side**, not just in the client | A hostile client that ignores its own role is [refused with `4403` and disconnected](test/server/websocket.test.ts), and the document is asserted unchanged |
| **Document ids are a closed character set** | Ids become filenames; `../` is rejected at the token boundary and again at the store |

And what is explicitly *not* solved: a malformed-but-valid document structure
written by an authorised client. If your application needs that guarantee, the
CRDT document cannot be the source of truth for it — you need a structure-aware
server that maintains its own replica and reverts states it considers invalid,
which is a different and much larger project.

### The token endpoint

`GET /api/token?doc=&user=&role=` mints a token so the demo works out of the
box. **It is an open grant of write access to any document.** It is enabled when
`NODE_ENV !== 'production'`, refuses with `403` otherwise, and the server logs a
warning on startup whenever it is on. In a real deployment your application
issues these after it has decided who the user is; this server only verifies
them. `COLLAB_AUTH_SECRET` is mandatory under `NODE_ENV=production` for the same
reason — a per-process generated secret would invalidate every token on restart
and could not be shared between replicas.

---

## Backpressure, so one slow client is not everyone's problem

Outbound traffic has two thresholds, because the two kinds of traffic have
different value:

- **Awareness frames are droppable.** A cursor position nobody received is
  superseded by the next one a few milliseconds later. Once a socket's buffer
  passes `COLLAB_AWARENESS_HWM`, awareness is the first thing discarded, and the
  drop is counted in `/metrics`.
- **Document updates are not droppable.** Silently dropping one diverges that
  peer forever. So when the buffer passes `COLLAB_MAX_BUFFERED_BYTES` the only
  correct move is to disconnect the peer with `4009`, which makes it resync from
  scratch on reconnect.

Inbound traffic is a token bucket per connection: `COLLAB_INBOUND_FPS` frames per
second with a burst of `COLLAB_INBOUND_BURST`. Exceeding it earns a `4429` and a
disconnect. Both paths are unit-tested against a socket whose `bufferedAmount`
the test controls, which is what makes "slow consumer" reproducible at all.

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `COLLAB_HOST` | `0.0.0.0` | Bind address |
| `COLLAB_PORT` | `1234` | Port (`0` picks a free one) |
| `COLLAB_AUTH_SECRET` | generated | HMAC secret for tokens. **Required** when `NODE_ENV=production` |
| `COLLAB_ALLOW_TOKEN_ENDPOINT` | on unless production | Enables `GET /api/token`. See the warning above |
| `COLLAB_DATA_DIR` | `data` | Update-log directory. Empty string means in-memory only |
| `COLLAB_STATIC_DIR` | auto | Built client to serve. Auto-detected next to the compiled server |
| `COLLAB_PERSIST_FLUSH_MS` | `200` | How long updates are coalesced before an append |
| `COLLAB_COMPACT_AFTER_FRAMES` | `64` | Compact once the log holds this many frames |
| `COLLAB_COMPACT_AFTER_BYTES` | `1048576` | Compact once the log reaches this size |
| `COLLAB_PRESENCE_TIMEOUT_MS` | `30000` | Expire a peer after this long without awareness |
| `COLLAB_PRESENCE_SWEEP_MS` | `5000` | How often the presence sweeper runs |
| `COLLAB_INBOUND_FPS` | `200` | Inbound frames per second, per connection |
| `COLLAB_INBOUND_BURST` | `400` | Token-bucket burst size |
| `COLLAB_AWARENESS_HWM` | `262144` | Buffered bytes above which awareness is dropped |
| `COLLAB_MAX_BUFFERED_BYTES` | `8388608` | Buffered bytes above which the peer is disconnected |
| `COLLAB_MAX_DOC_BYTES` | `16777216` | Per-document accepted-update-bytes quota |
| `COLLAB_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

HTTP endpoints: `GET /healthz`, `GET /metrics` (Prometheus text format),
`GET /api/token`, plus the static client. WebSocket endpoint: `/ws`.

---

## Testing

A screenshot of two cursors proves that two sockets are open. These are the
things that prove the system works, in order of how much they prove.

**Headless convergence** — [`test/crdt/convergence.test.ts`](test/crdt/convergence.test.ts).
Several `Y.Doc`s in one process, with the network replaced by an array of update
frames the test delivers in whatever order it likes: reversed, duplicated,
delayed, or withheld from one replica until the very end. Includes
offline-then-reconnect and a three-way partition where all three replicas
rewrote the same word.

Every assertion requires **byte-identical encoded state**, not merely equal
text. Two replicas can render the same string from different internal histories
and then diverge on the next edit; comparing `Y.encodeStateAsUpdate` byte for
byte is the property that makes further convergence inevitable. The helper also
refuses to pass on an empty document, so a suite that converged three blank
replicas fails instead of going green.

**Property-based convergence** — [`test/crdt/property.test.ts`](test/crdt/property.test.ts).
The CRDT guarantee has a quantifier in it — *for any* sequence of operations
delivered in *any* order *any* number of times — so it gets a quantified test.
`fast-check` generates the edits and the delivery schedule for 2, 3 and 4
replicas across 520 runs. Each property also records what it exercised and
asserts afterwards that the generator produced genuine divergence before
delivery and documents of non-trivial size, so a run cannot pass vacuously.

**Server integration over a real WebSocket** —
[`test/server/websocket.test.ts`](test/server/websocket.test.ts).
These drive the **production client provider** over a real socket against a real
server; the only difference from the browser is which `WebSocket` constructor is
injected. They assert recovered *text*, not that a message arrived:

- a client edits, disconnects, the room closes, a second client connects and
  receives the persisted document — with `server.room(id) === undefined`
  asserted in between, so the state demonstrably came from the store;
- the same across a **full server shutdown and restart** against a real
  directory on disk;
- compaction happening under live traffic, then full recovery from the compacted
  log;
- a three-way offline merge where two clients rewrote the same word;
- presence appearing, disappearing on disconnect, and **expiring with the socket
  still open**;
- forged tokens, expired tokens, read-only enforcement, oversized updates,
  undecodable updates, rate limiting, and `/metrics` reflecting live rooms.

**Real browsers** — [`test/e2e/collab.spec.ts`](test/e2e/collab.spec.ts).
Two Playwright browser contexts on one document, against the production build
served by the real server. Type in both, assert both panes render the merged
text; take one offline, type, reload, and assert the text is still there *while
the peer still cannot see it* — which is what makes it evidence about IndexedDB
rather than about the server.

```
 87 tests  vitest      protocol, auth, store, connection, room,
                       convergence, property, real-WebSocket integration
  4 tests  playwright  two browser contexts, offline reload, three-way merge,
                       recovery after every client left
```

**CI does not trust the green tick.** Both suites write a machine-readable
report, and [`scripts/check-test-report.mjs`](scripts/check-test-report.mjs) and
[`scripts/check-e2e-report.mjs`](scripts/check-e2e-report.mjs) then assert a
floor on the number of tests, that nothing was skipped, and that the specific
suites covering persistence, compaction, presence, convergence and the
three-way merge were *present in that run*. A suite that compiles, runs and
tests nothing is the failure mode these guard against.

---

## Limitations

- **Single process.** Rooms live in memory on one server, so there is no
  horizontal scaling. Adding it means either sticky routing per document or a
  pub/sub fan-out between replicas; the `DocumentStore` interface is the seam
  where a shared backend would go.
- **No version history or rollback.** The compacted log is the current state,
  not a timeline. Since a write-authorised client can legitimately delete
  everything, a production deployment wants periodic snapshots kept separately —
  that is the real answer to vandalism, as discussed above.
- **No document lifecycle.** Documents are created implicitly by connecting with
  a token for them and are never garbage-collected.
- **Appends are not `fsync`ed.** See the durability note above.
- **One text field.** The demo binds a single `Y.Text` named `body`. Nothing in
  the server is text-specific — it relays opaque updates — but the client
  binding is.
- **The container is only exercised by CI.** The host this was developed on has
  no Docker daemon. CI builds the image, starts it, and asserts `/healthz`,
  `/metrics`, the served client, the token endpoint and that the process runs as
  a non-root user — so the image is verified, just not by hand on a laptop.

## License

MIT — see [LICENSE](LICENSE).
