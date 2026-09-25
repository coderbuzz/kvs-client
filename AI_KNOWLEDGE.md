<!-- docs: sync from coderbuzz/codex@15d78e0 -->

# KVS Client: AI Agent Knowledge File

**Package:** `@coderbuzz/kvs-client`
**Purpose:** TypeScript client SDK for `@coderbuzz/kvs-server`. REST-first, transparently upgrades to WebSocket RPC.
**Distribution:** ESM only (`dist/index.js` + `dist/index.d.ts`).
**Dependencies:** none, and no peer dependencies. It does not import `@coderbuzz/kvs`; all types are local copies. Install: `npm install @coderbuzz/kvs-client`.

---

## Mental Model

KVS Client talks to a `@coderbuzz/kvs-server` instance. REST by default, WebSocket RPC after `open()`.

```
KvsClient
  ├── REST transport (default, via fetch POST)
  └── WebSocket RPC (after open())
        ├── All KV/queue methods (lower latency)
        ├── watch()   : real-time key subscriptions
        └── listen()  : push queue delivery (awaited handler, auto ack/nack, concurrency)
```

After a disconnect, ordinary methods fall back to REST. All methods work over both transports except `watch()` and `listen()`, which require an open WebSocket. Optional reconnect restores subscriptions from a fresh server snapshot.

---

## Complete Import

```ts
import {
  KvsClient,
  type KvsClientOptions,
  Singleflight,
  AtomicBuilder,
} from "@coderbuzz/kvs-client";

// All types included: no additional packages needed
import type {
  KvKey, KvKeyPart, KvEntry, KvWatchEvent,
  KvCommitResult, KvCommitError,
  KvCheck, KvMutation,
  KvListSelector, KvListOptions, KvListResult,
  QueueMessage, QueueOptions,
} from "@coderbuzz/kvs-client";
```

`Singleflight` is a separate implementation in `kvs-client` (not re-exported from `kvs`). It works identically.

---

## Types

```ts
type KvKeyPart = string | number | bigint | boolean | Uint8Array
type KvKey = KvKeyPart[]

interface KvEntry {
  key: KvKey
  value: unknown
  version: number
}

interface KvWatchEvent {
  sequence?: number  // monotonic within one server process
  reset?: boolean    // true when reset() produced the tombstone snapshot
}

interface KvCommitResult { ok: true; version: number }
interface KvCommitError { ok: false }

interface KvCheck {
  key: KvKey
  version: number | null   // number = "key must be at this version"
                            // null   = "key must not exist"
}

interface KvMutation { type: "set" | "delete"; key: KvKey; value?: unknown; ttl?: number }

interface KvListSelector { prefix?: KvKey; start?: KvKey; end?: KvKey }
interface KvListOptions { limit?: number; cursor?: string; reverse?: boolean }
interface KvListResult { entries: KvEntry[]; cursor: string | null }

interface QueueMessage {
  id: number; topic: string; payload: unknown
  enqueuedAt: number; deliverAt: number
  attempts: number; maxAttempts: number
  token: string           // lease token: acknowledge/nack/extendLease need it
  lockedUntil: number     // lease end, ms epoch
  lastError: string | null
}
interface QueueDeadMessage {
  id: number; topic: string; payload: unknown
  enqueuedAt: number; deliverAt: number; attempts: number; maxAttempts: number
  lastError: string | null; failedAt: number
}
interface QueueOptions { topic?: string; delay?: number; maxAttempts?: number }
interface QueueNackOptions { error?: string; delay?: number }
interface QueueListenOptions { concurrency?: number; visibilityTimeout?: number; autoAck?: boolean }
interface QueueStats {
  topic: string; pending: number; delayed: number; processing: number
  dead: number; done: number; oldestPendingAt: number | null
}
```

---

## Constructor

### `new KvsClient(options: KvsClientOptions)`

```ts
interface KvsClientOptions {
  url: string                  // required; trailing slashes stripped
  token: string                // required bearer token
  autoReconnect?: boolean      // default false
  reconnectMinDelayMs?: number // default 250; clamped to >= 50
  reconnectMaxDelayMs?: number // default 10_000; clamped to >= min
}
```

`url` and `token` are required. Reconnect is opt-in for backward compatibility.

```ts
const kv = new KvsClient({ url: "http://localhost:3000", token: "secret" });
```

Initializes REST transport (`fetch`-based POST). WebSocket state is `null`.

**Public property:** `kv.sf: Singleflight`, the singleflight instance used by `getAsync()`.

---

## Connection Methods

### `open(): Promise<void>`

1. Idempotent and singleflight: returns immediately if OPEN; concurrent attempts share `openPromise`.
2. Connects to `ws://host:port/ws` (derived from `url`, `http` → `ws`).
3. On `open`: sends auth RPC `{ id, method: "auth", params: { token } }`.
4. On auth success: switches `_transport` from REST to WebSocket RPC.
5. On failure: a socket error rejects with `"WebSocket connection failed"`. A wrong token makes the server reply `{ id, error: "Unauthorized" }` and close with 4001, so `open()` rejects with `Error("Unauthorized")`. The `"WebSocket authentication failed"` branch (close socket, reset transport) runs only if the auth result lacks `ok`.
6. On reconnect: resets watch sequence tracking, re-registers the watch, and re-registers every queue topic after authentication.

```ts
await kv.open();
// All subsequent KV/queue calls now go over WebSocket
```

### `close(): void`

1. Nulls out `ws`, resets `_transport` to REST.
2. Cancels any reconnect timer, closes WebSocket, and clears `watchSubscription` and `queueCallbacks`.
3. Rejects all pending RPC promises with `"WebSocket closed"`.
4. All subsequent calls revert to REST automatically.

```ts
kv.close();
// Back to REST transport
```

---

## KV Methods

All methods work over both REST and WebSocket (auto-selected based on `open()` state).

### `get(key: KvKey): Promise<KvEntry | null>`

```ts
const entry = await kv.get(["users", "alice"]);
// { key: ["users", "alice"], value: { name: "Alice" }, version: 1 } | null
```

### `set(key: KvKey, value: unknown, options?: { ttl?: number }): Promise<KvCommitResult>`

```ts
const result = await kv.set(["users", "alice"], { name: "Alice" });
// { ok: true, version: 1 }

await kv.set(["cache", "key"], value, { ttl: 60_000 }); // expires in 60s
```

Every `set` increments `version` by 1. TTL is in milliseconds.

### `delete(key: KvKey): Promise<{ ok: true }>`

```ts
await kv.delete(["users", "alice"]);
// { ok: true }
```

### `list(selector: KvListSelector, options?: KvListOptions): Promise<KvListResult>`

```ts
// Prefix query
const result = await kv.list({ prefix: ["users"] });
// { entries: [...], cursor: string | null }

// Range query
await kv.list({ start: ["events", 1000], end: ["events", 2000] });

// Paginated
const page1 = await kv.list({ prefix: ["logs"] }, { limit: 20 });
const page2 = await kv.list({ prefix: ["logs"] }, { limit: 20, cursor: page1.cursor });

// Reverse
await kv.list({ prefix: ["logs"] }, { limit: 5, reverse: true });
```

Defaults: `limit: 100`, max `1000`, ascending, `reverse: false`. `cursor` is opaque base64.

### `atomic(): AtomicBuilder`

Returns a fluent builder. `commit()` is the terminal async method. All operations run in a single transaction on the server.

```ts
const result = await kv.atomic()
  .check({ key: ["users", "123"], version: 5 })           // optimistic lock
  .check({ key: ["users", "counter"], version: null })     // key must not exist
  .set(["users", "123"], newData, { ttl: 3600_000 })
  .delete(["cache", "stale"])
  .enqueue({ task: "notify" }, { topic: "emails" })
  .commit();
// { ok: true, version: 6 } | { ok: false }
```

**AtomicBuilder methods:**

| Method | Signature | Description |
|---|---|---|
| `check` | `(...checks: KvCheck[]): this` | Assert key versions. `version: null` = "must not exist". `version: N` = "must be at version N". |
| `set` | `(key, value, options?): this` | `options: { ttl?: number }` |
| `delete` | `(key): this` | |
| `enqueue` | `(payload, options?): this` | `options: QueueOptions` |
| `commit` | `(): Promise<KvCommitResult \| KvCommitError>` | Execute all atomically. Returns `{ ok: false }` if any check fails. |

### `getAsync<T>(key: KvKey, fn: () => T | Promise<T>, ttl?: number): Promise<T>`

Cache-with-compute with singleflight deduplication and cross-process safety.

```ts
// 100 concurrent callers on one client: fn() runs once
const ad = await kv.getAsync(["ads", "venue", 42], () => fetchNextAd(42), 30_000);
```

**Algorithm:**
1. Singleflight dedup within process (`this.sf.do(JSON.stringify(key), ...)`)
2. Check server cache via `get(key)`: return immediately on hit
3. Call `fn()` exactly once
4. Atomic check-and-set: `check({ key, version: null }).set(key, value, { ttl }).commit()`
5. If CAS succeeds → return computed value
6. If CAS fails (another client wrote first) → re-read from server and return that value

The `version: null` check means "only write if key doesn't exist". Singleflight is per `KvsClient` instance, so N instances on a cold key can run `fn()` up to N times; the CAS ensures only the first write is stored and every caller returns that stored value (or its own value if the re-read finds nothing).

---

## Queue Methods

All work over both transports. A dequeued (or pushed) message is **leased** to you: it carries a `token`, and you finish it with `acknowledge(msg.id, msg.token)` or give it back with `nack(...)`. A message neither acked nor nacked before `msg.lockedUntil` is delivered again; after `maxAttempts` deliveries it is dead-lettered.

### `enqueue(payload: unknown, options?: QueueOptions): Promise<{ ok: true, id: number }>`

**Defaults:** `topic: "default"`, `delay: 0`, `maxAttempts: 3` (integer >= 1).

```ts
const result = await kv.enqueue(
  { to: "user@example.com", subject: "Welcome" },
  { topic: "emails", delay: 5_000, maxAttempts: 5 },
);
// { ok: true, id: 1 }
```

### `dequeue(topic?: string, limit?: number, options?: { visibilityTimeout?: number }): Promise<QueueMessage[]>`

**Defaults:** `topic: "default"`, `limit: 1`, `visibilityTimeout`: the server store's (30 s).

```ts
for (const msg of await kv.dequeue("emails", 10)) {
  try {
    await sendEmail(msg.payload);
    await kv.acknowledge(msg.id, msg.token);
  } catch (error) {
    await kv.nack(msg.id, msg.token, { error: String(error) }); // retried after the backoff
  }
}
```

### `acknowledge(id: number, token: string): Promise<boolean>`

`true` when acknowledged; `false` when the lease is no longer yours (it expired and the message went to someone else). A missing token throws `TypeError`.

### `nack(id: number, token: string, options?: { error?: string, delay?: number }): Promise<boolean>`

Retry after `delay` ms (default: the server's backoff), or dead-letter on the last attempt. `error` becomes the message's `lastError`.

### `extendLease(id: number, token: string, visibilityTimeout?: number): Promise<boolean>`

Keep a long job's lease; `0` hands the message back at once.

### `listDead(topic?, { limit?, after? }?)`, `retryDead(topic?, id?)`, `deleteDead(topic?, id?)`, `queueStats(topic?)`

```ts
const dead = await kv.listDead("emails");      // QueueDeadMessage[]: lastError, failedAt
await kv.retryDead("emails", dead[0].id);      // or all: kv.retryDead("emails")
await kv.deleteDead("emails");
await kv.queueStats("emails");                 // [{ topic, pending, delayed, processing, dead, done, oldestPendingAt }]
```

**Message lifecycle (server-side):**
```
pending ──dequeue / push──▶ processing (leased) ──acknowledge──▶ deleted
   ▲                            │
   └── nack or lease expiry ────┤ (retried after the backoff)
                                └── last attempt failed ──▶ dead ── retryDead ─▶ pending
```

---

## Watch & Listen (require WebSocket: `open()` first)

Both throw `"WebSocket not connected. Call open() first."` if WebSocket is not open.

### `watch(keys: KvKey[], callback: (entries: (KvEntry | null)[], event?: KvWatchEvent) => void): { cancel: () => void }`

Real-time key-change subscriptions. Fires immediately with current values, then on every mutation.

```ts
await kv.open();
const { cancel } = kv.watch(
  [["config", "theme"], ["config", "lang"]],
  (entries, event) => {
    // entries[0] = KvEntry | null for ["config", "theme"]
    // entries[1] = KvEntry | null for ["config", "lang"]
    // event.sequence is ordered within this server process
    // event.reset is true for a reset tombstone batch
  },
);
cancel(); // unsubscribe: sends /kv/unwatch RPC
```

**Limitations:**
- Only ONE watch active per client: setting a new watch overwrites the previous callback.
- Cancel sends `/kv/unwatch` RPC.
- Fires the full set of current values for ALL watched keys (not just the changed one).
- Errors from callbacks are silently caught, so they won't break the WebSocket dispatch.

**Wire format (server → client push):**
```json
{ "type": "watch", "entries": [{ "key": [...], "value": ..., "version": ... } | null, ...], "sequence": 42 }
```
`reset: true` is added only on reset tombstone snapshots; the server omits it otherwise.

**Watch internals on server:** Core KVS emits one committed mutation batch per operation. Changed entries are reused directly and unchanged watched keys are read at most once per batch. KVS Server groups identical ordered key lists into one core watcher, one serialized payload, then fans that payload out to all peers.

### `listen(topic: string, handler: (msg: QueueMessage) => unknown, options?: QueueListenOptions): { cancel: () => void }`

Push-based queue delivery. **Requires `open()`.** By default the handler is awaited: the message is acknowledged when it resolves and nacked (retried, dead-lettered after `maxAttempts`) when it throws.

```ts
await kv.open();

const { cancel } = kv.listen("emails", async (msg) => {
  await sendEmail(msg.payload); // throw to retry
}, { concurrency: 4 });

cancel(); // unsubscribe: sends /queue/unlisten RPC
```

| Option | Default | Meaning |
|---|---|---|
| `concurrency` | `1` | Messages the server pushes before you ack or nack them |
| `visibilityTimeout` | server store's | Lease length, ms |
| `autoAck` | `true` | `false`: call `acknowledge(msg.id, msg.token)` / `nack()` yourself |

**Behavior:**
- The server pushes at most `concurrency` messages and waits for their ack or nack (or lease expiry) before pushing more.
- One handler per topic per client: calling again for the same topic replaces it. Multiple topics can be listened to simultaneously.
- Listeners on other clients share the topic: whoever has a free slot gets the next message.
- If the connection drops, the server hands the unacked messages back at once.
- Without `autoReconnect`, an unexpected disconnect drops all watch/listen subscriptions; call `open()` and subscribe again.

**Wire format (server → client push):**
```json
{ "type": "queue", "topic": "emails", "message": { "id": 1, "payload": ..., "attempts": 1, "maxAttempts": 3,
  "token": "3f0c6c1e-...", "lockedUntil": 1700000030000, "lastError": null, "enqueuedAt": ..., "deliverAt": ... } }
```

**Client internals:** `queueCallbacks: Map<topic, { handler, options }>`. On a push, `deliver()` awaits the handler, then (unless `autoAck === false`) calls `acknowledge(id, token)` or, if it threw, `nack(id, token, { error: error.message })` over the current transport (WebSocket RPC, or REST after a disconnect). A failing ack/nack is swallowed: the lease runs out and the server delivers the message again. On reconnect every topic is re-sent as `/queue/listen` with its `concurrency`/`visibilityTimeout`.

**Server side (kvs-server 5):** a store listener with `autoAck: false` whose handler promise stays pending until this client's ack/nack for that id+token, the lease end, or the connection close. That pending promise is what holds one of the `concurrency` slots.

---

## Utility Methods

### `health(): Promise<{ ok: boolean, uptime: number }>`

Direct GET request. Bypasses both REST and WebSocket transports. No auth required.

```ts
const status = await kv.health();
// { ok: true, uptime: 123.456 }
```

Uses `fetch(`${url}/health`)` directly, not the transport layer.

### `reset(): Promise<{ ok: true }>`

Deletes ALL data from `kv` and `queue` tables on the server. Existing watchers remain registered and receive a `reset: true` null snapshot. For testing only.

```ts
await kv.set(["users", "alice"], { name: "Alice" });
await kv.enqueue("test");
await kv.reset();
const entry = await kv.get(["users", "alice"]); // null
```

### `cleanExpired(): Promise<{ ok: true, deleted: number }>`

Manually expire stale KV entries on the server. Returns count of deleted rows. (Auto-runs every 60s on server.)

```ts
await kv.set(["cache", "a"], "x", { ttl: 1_000 });
await kv.set(["cache", "b"], "y", { ttl: 1_000 });
// After 2s, entries are expired: cleanExpired() removes them immediately
const { deleted } = await kv.cleanExpired(); // 2
```

---

## Transport Architecture

```
                      ┌──────────────────────────────────┐
                      │         KvsClient                 │
                      │   _transport: (method, params) => │
                      │     Promise<any>                  │
                      └──────────┬───────────────────────┘
                                 │
                ┌────────────────┴────────────────┐
                ▼                                  ▼
      ┌─────────────────┐              ┌─────────────────────┐
      │   _post (REST)  │              │    _rpc (WebSocket) │
      │   fetch POST    │              │   JSON-RPC via WS   │
      │   to url+path   │              │   {id,method,params}│
      └─────────────────┘              └─────────────────────┘
           DEFAULT                           AFTER open()
```

| Feature | REST | WebSocket RPC |
|---|---|---|
| Default | Yes | No (requires `open()`) |
| Latency | Request-response | Lower (persistent connection) |
| Watch | N/A | Yes |
| Listen | N/A | Yes |
| Disconnect | Still available | Falls back to REST; optional reconnect restores subscriptions |

**REST transport details:**
- All KV/queue methods use `fetch POST` to `{url}{path}` with `Authorization: Bearer {token}` header.
- Body: `JSON.stringify(params)`.
- Response: `res.json()`.
- On HTTP error status: throws `"KVS {path}: {status} {statusText}"`.
- `health()` uses raw `fetch GET {url}/health`, bypassing the transport layer.

**WebSocket RPC details:**
- Counter `rpcId` starts at 0 and is pre-incremented per call (`++rpcId`), so the first id is 1. It never resets.
- `rpcCallbacks: Map<number, { resolve, reject }>` stores pending promises by id.
- On message: if `data.id` exists → lookup callback. Watch pushes go to `watchSubscription.callback`; queue pushes go to `queueCallbacks.get(topic)`.
- On close: rejects all pending RPCs and falls back to REST. If `autoReconnect` is false, subscriptions are cleared. If true, they are retained and restored after reconnect.
- Malformed messages silently ignored (try/catch in onmessage).

---

## Default Values Reference

| Method | Parameter | Default |
|---|---|---|
| `set(key, value, options)` | `options` | `{}` (no TTL) |
| `enqueue(payload, options)` | `options.topic` | `"default"` |
| | `options.delay` | `0` |
| | `options.maxAttempts` | `3` |
| `dequeue(topic, limit, options)` | `topic` | `"default"` |
| | `limit` | `1` |
| | `options.visibilityTimeout` | server store's (30 s) |
| `listen(topic, handler, options)` | `concurrency` / `autoAck` | `1` / `true` |
| `listDead(topic, options)` | `limit` / `after` | `100` / `0` (server) |
| constructor | `autoReconnect` | `false` |
| | `reconnectMinDelayMs` | `250` |
| | `reconnectMaxDelayMs` | `10000` |

---

## Singleflight (standalone)

Exported for deduplicating concurrent async work. Same API as `@coderbuzz/kvs`'s `Singleflight` but separate implementation.

```ts
import { Singleflight } from "@coderbuzz/kvs-client";

const sf = new Singleflight<User>();

// 100 concurrent calls for "user:42": fetchUser() runs once
const user = await sf.do("user:42", () => fetchUser(42));

sf.size;           // number of in-flight keys
sf.clear();        // clear all in-flight
```

Used internally by `getAsync()`. Can also be used standalone for any deduplication needs.

---

## Gotchas

1. `open()` required for `watch()`/`listen()`: throws `"WebSocket not connected. Call open() first."` if not connected.
2. Explicit `close()` always cancels reconnect and subscriptions; an unexpected close preserves them only when `autoReconnect: true`.
3. Only ONE active `watch()` per client: calling `watch()` again overwrites the previous subscription.
4. One `listen()` callback per topic: calling `listen()` again for the same topic overwrites. Multiple topics can be active.
5. `listen()` handlers are awaited and auto-acked (resolve) or nacked (throw). Do not also call `acknowledge()` in them, or pass `autoAck: false`.
6. `getAsync()` uses `JSON.stringify(key)` as singleflight dedup key. Uses atomic `check({ version: null })` for cross-process safety: two clients computing the same key, one wins and the other re-reads.
7. `health()` is the only method that bypasses auth: direct GET request, no transport layer.
8. No dependency or peer dependency on `@coderbuzz/kvs`. The client ships its own types; its `KvWatchEvent` is `{ sequence?, reset? }`, a subset of the store's `KvWatchEvent` (no `initial`, `changedKeys`, `coalesced`).
9. WebSocket auth happens via RPC `auth` after connection. Query-string tokens are a server migration option and should be disabled in production because URLs can be logged.
10. `Singleflight` in `kvs-client` is a separate class from the one in `kvs`. Same API, separate implementation.
11. No `increment` endpoint: the server doesn't expose a dedicated increment RPC. Use `get` + `set` or `atomic()` with version checks for atomic counters.
12. New messages (including `atomic()` enqueues) are pushed at once; delayed messages, retries and expired leases within about a second.
13. A message not acked or nacked before `lockedUntil` is delivered again (default lease 30 s from the dequeue; `extendLease()` for longer jobs). `acknowledge()` with a stale token returns `false`.
14. `watch()`, `unwatch`, `listen()`, and `unlisten` are sent without an `id`. If the server rejects them (empty key list, more than `maxWatchKeys`, forbidden key or topic), its reply has no `id` and no `type`, so `onmessage` drops it: no error is thrown and no events arrive.
15. With `autoReconnect: true`, a rejected token also triggers the reconnect loop: the server closes the socket after the auth error, `onclose` schedules a reconnect, and it keeps retrying with backoff (capped at `reconnectMaxDelayMs`) until `close()` is called.
16. The WebSocket URL is `url` with a leading `http` replaced by `ws` (so `https` becomes `wss`) plus `/ws`. Auth always uses the post-connect `auth` RPC, never a query token.

---

## REST Endpoint Mapping

Each KvsClient method maps to a specific HTTP endpoint:

| Client Method | HTTP Method | Endpoint Path | Request Body |
|---|---|---|---|
| `get` | POST | `/kv/get` | `{ key }` |
| `set` | POST | `/kv/set` | `{ key, value, ttl? }` |
| `delete` | POST | `/kv/delete` | `{ key }` |
| `list` | POST | `/kv/list` | `{ prefix?, start?, end?, limit?, cursor?, reverse? }` |
| `atomic().commit()` | POST | `/kv/atomic` | `{ checks?, mutations?, enqueues? }` |
| `enqueue` | POST | `/queue/enqueue` | `{ payload, topic?, delay?, maxAttempts? }` |
| `dequeue` | POST | `/queue/dequeue` | `{ topic?, limit?, visibilityTimeout? }` |
| `acknowledge` | POST | `/queue/ack` | `{ id, token }` |
| `nack` | POST | `/queue/nack` | `{ id, token, error?, delay? }` |
| `extendLease` | POST | `/queue/extend` | `{ id, token, visibilityTimeout? }` |
| `listDead` | POST | `/queue/dead` | `{ topic?, limit?, after? }` |
| `retryDead` | POST | `/queue/retry-dead` | `{ topic?, id? }` |
| `deleteDead` | POST | `/queue/delete-dead` | `{ topic?, id? }` |
| `queueStats` | POST | `/queue/stats` | `{ topic? }` |
| `reset` | POST | `/kv/reset` | `{}` |
| `cleanExpired` | POST | `/kv/clean-expired` | `{}` |
| `health` | GET | `/health` | none (no body, no auth) |

**REST transport details:**
- All POST requests use `Content-Type: application/json` and `Authorization: Bearer {token}` headers.
- All POST responses are JSON parsed from `res.json()`.
- Non-2xx status → throws `Error("KVS {path}: {status} {statusText}")`.
- `health()` bypasses the transport layer entirely, using raw `fetch(this.url + "/health")`.

**WebSocket RPC:** Same payload shapes sent as `{ id, method, params }` JSON-RPC messages. Responses come back as `{ id, result }` or `{ id, error }`.

---

## Transport Internals

### `_post(path, params)`: REST transport
```ts
private async _post(path: string, params: unknown): Promise<any> {
  const res = await fetch(`${this.url}${path}`, {
    method: "POST",
    headers: this.headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`KVS ${path}: ${res.status} ${res.statusText}`);
  return res.json();
}
```
- Each call is an independent `fetch`; concurrent calls run in parallel.
- Non-2xx status rejects the returned promise with `Error("KVS {path}: {status} {statusText}")`.

### `_rpc(path, params)`: WebSocket RPC
```ts
private _rpc(path: string, params: unknown): Promise<any> {
  const id = ++this.rpcId;
  return new Promise((resolve, reject) => {
    this.rpcCallbacks.set(id, { resolve, reject });
    this.ws!.send(JSON.stringify({ id, method: path, params }));
  });
}
```
- Increments `rpcId` (a JS number starting at 0, never reset; exact up to `Number.MAX_SAFE_INTEGER`).
- Stores `{ resolve, reject }` in `rpcCallbacks` Map keyed by `id`.
- Sends JSON-RPC request over WebSocket.
- Response routed via `onmessage` handler: lookup by `data.id`, call `resolve(data.result)` or `reject(new Error(data.error))`.

### Transport Switching
- Constructor sets `this._transport = this._post.bind(this)`: REST is default.
- `open()` on success sets `this._transport = this._rpc.bind(this)`: switches to WebSocket.
- Any close sets `this._transport = this._post.bind(this)`: requests remain usable through REST.
- All public methods call `await this._transport(path, params)`, staying transport-agnostic.
- `openPromise` makes simultaneous `open()` calls share one attempt.
- Automatic reconnect uses `min(maxDelay, minDelay * 2 ** attempts)` with a random 0.75–1.25 multiplier. Successful authentication resets `attempts` to zero.

### WebSocket `onmessage` Handler
```ts
ws.onmessage = (event) => {
  const data = JSON.parse(String(event.data));
  if ("id" in data) {
    // RPC response
    const cb = this.rpcCallbacks.get(data.id);
    if (cb) {
      this.rpcCallbacks.delete(data.id);
      if ("error" in data) cb.reject(new Error(data.error));
      else cb.resolve(data.result);
    }
  } else if (data.type === "watch") {
    const subscription = this.watchSubscription;
    if (!subscription) return;
    const sequence = typeof data.sequence === "number" ? data.sequence : null;
    if (sequence !== null && subscription.lastSequence !== null
        && sequence < subscription.lastSequence) return;
    if (sequence !== null) subscription.lastSequence = sequence;
    subscription.callback(data.entries, {
      sequence: sequence ?? undefined,
      reset: data.reset === true || undefined,
    });
  } else if (data.type === "queue") {
    const subscription = this.queueCallbacks.get(data.topic);
    if (subscription) void this.deliver(subscription, data.message); // await handler, then ack/nack
  }
  // Malformed JSON silently ignored via catch
};
```

### WebSocket `onclose` Handler
```ts
ws.onclose = () => {
  if (this.ws !== ws) return;                   // ignore stale socket events
  this.ws = null;
  this._transport = this._post.bind(this);     // fallback to REST
  for (const cb of this.rpcCallbacks.values()) {
    cb.reject(new Error("WebSocket closed"));   // reject all pending
  }
  this.rpcCallbacks.clear();
  if (this.autoReconnect && !this.closedByUser) {
    this.scheduleReconnect();                   // preserve subscriptions
  } else if (!this.autoReconnect) {
    this.watchSubscription = null;
    this.queueCallbacks.clear();
  }
};
```

---

## Push Event Flow

### Watch Flow
```
Client: watch(keys, callback)
  → ws.send({ method: "/kv/watch", params: { keys } })
  → sets this.watchSubscription = { keys, callback, lastSequence: null }
     (overwrites previous if any)

Server: joins or creates an ordered-key WatchHub group
  → one underlying store.watch() per identical key list
  → immediately returns the cached/current full snapshot
  → one serialization per committed mutation batch, fan-out to group peers

Push message (server → client):
{ "type": "watch", "entries": [entry|null, ...], "sequence": 42 }   // "reset": true only on reset

Client onmessage:
  → discard a decreasing sequence on the current connection
  → callback(data.entries, { sequence, reset })

Unexpected disconnect with autoReconnect:
  → fall back to REST while offline
  → authenticate a replacement socket using exponential backoff
  → reset lastSequence and re-subscribe
  → initial push supplies the current snapshot, covering the offline interval

Cancel:
  client: ws.send({ method: "/kv/unwatch" })
  → client: this.watchSubscription = null
  → server: removes peer and cancels the core watcher when its group is empty
```

### Listen Flow
```
Client: listen(topic, handler, { concurrency, visibilityTimeout, autoAck })
  → ws.send({ method: "/queue/listen", params: { topic, concurrency, visibilityTimeout } })
  → sets this.queueCallbacks.set(topic, { handler, options })
     (overwrites previous for same topic, allows multiple topics)

Server: store.addQueueListener(topic, h, { concurrency, visibilityTimeout, autoAck: false })
  → h pushes the message and stays pending until the ack/nack for id+token,
    the lease end or the connection close: at most `concurrency` pushed, unacked messages

Push message (server → client):
{ "type": "queue", "topic": "...", "message": QueueMessage }   // with token, lockedUntil

Client onmessage:
  → deliver(): await handler(msg) → acknowledge(msg.id, msg.token) | nack(msg.id, msg.token, { error })
     (skipped with autoAck: false)

Cancel:
  client: ws.send({ method: "/queue/unlisten", params: { topic } })
  → client: this.queueCallbacks.delete(topic)
  → server: cancels the store listener; already pushed messages stay leased until acked or expired

Disconnect:
  → server releases the leases of unacked pushed messages (delivered again at once)
```

---

## RPC Callback Lifecycle

```
  call _rpc(path, params)
    → rpcId++
    → create Promise + store { resolve, reject } in rpcCallbacks[id]
    → ws.send({ id, method, params })
    ↘
      onmessage receives response with matching id
        → lookup rpcCallbacks[id]
        → if "result" in data: resolve(data.result)
        → if "error" in data: reject(new Error(data.error))
        → delete rpcCallbacks[id]
    ↙ OR
      onclose fires before response
        → for each pending callback: reject(new Error("WebSocket closed"))
        → clear rpcCallbacks
```

Pending RPC callbacks are orphaned if:
- WebSocket closes unexpectedly (rejected with `"WebSocket closed"`)
- Server crashes before responding (same rejection via onclose)
- Server sends malformed response without matching `id` (orphaned, never resolved: potential memory leak if server is buggy)

---

## Server & Client Packages

- `@coderbuzz/kvs`: the embeddable store engine (SQLite/PostgreSQL) used by the server
- `@coderbuzz/kvs-server`: wraps the store into HTTP REST + WebSocket server
- `@coderbuzz/kvs-client`: this package, the TypeScript SDK for the server
