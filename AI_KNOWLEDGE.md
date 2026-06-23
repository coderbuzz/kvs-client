<!-- docs: sync from coderbuzz/codex@c0ec729 -->

# KVS Client — AI Agent Knowledge File

**Package:** `@coderbuzz/kvs-client` v0.2.6
**Purpose:** TypeScript client SDK for `@coderbuzz/kvs-server`. REST-first, transparently upgrades to WebSocket RPC.
**Distribution:** ESM only (`dist/index.js` + `dist/index.d.ts`).

---

## Mental Model

KVS Client talks to a `@coderbuzz/kvs-server` instance. REST by default, WebSocket RPC after `open()`.

```
KvsClient
  ├── REST transport (default, via fetch POST)
  └── WebSocket RPC (after open())
        ├── All KV/queue methods (lower latency)
        ├── watch()   — real-time key subscriptions
        └── listen()  — push queue delivery
```

After `close()`, falls back to REST. All methods work over both transports except `watch()` and `listen()` which require WebSocket.

---

## Complete Import

```ts
import {
  KvsClient,
  type KvsClientOptions,
  Singleflight,
  AtomicBuilder,
} from "@coderbuzz/kvs-client";

// All types included — no additional packages needed:
import type {
  KvKey, KvKeyPart, KvEntry,
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
}
interface QueueOptions { topic?: string; delay?: number; maxAttempts?: number }
```

---

## Constructor

### `new KvsClient(options: KvsClientOptions)`

```ts
interface KvsClientOptions {
  url: string    // Server base URL, e.g. "http://localhost:3000" (trailing slashes stripped)
  token: string  // Bearer access token (required)
}
```

Both fields are required. No defaults.

```ts
const kv = new KvsClient({ url: "http://localhost:3000", token: "secret" });
```

Initializes REST transport (`fetch`-based POST). WebSocket state is `null`.

**Public property:** `kv.sf: Singleflight` — the singleflight instance used by `getAsync()`.

---

## Connection Methods

### `open(): Promise<void>`

1. Idempotent — returns immediately if WebSocket already OPEN.
2. Connects to `ws://host:port/ws` (derived from `url`, `http` → `ws`).
3. On `open`: sends auth RPC `{ id, method: "auth", params: { token } }`.
4. On auth success: switches `_transport` from REST to WebSocket RPC.
5. On auth failure: closes socket, resets transport, throws `"WebSocket authentication failed"`.

```ts
await kv.open();
// All subsequent KV/queue calls now go over WebSocket
```

### `close(): void`

1. Nulls out `ws`, resets `_transport` to REST.
2. Closes WebSocket, clears `watchCallback` and `queueCallbacks`.
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
// 100 concurrent callers — fn() runs once across all clients on this machine
const ad = await kv.getAsync(["ads", "venue", 42], () => fetchNextAd(42), 30_000);
```

**Algorithm:**
1. Singleflight dedup within process (`this.sf.do(JSON.stringify(key), ...)`)
2. Check server cache via `get(key)` — return immediately on hit
3. Call `fn()` exactly once
4. Atomic check-and-set: `check({ key, version: null }).set(key, value, { ttl }).commit()`
5. If CAS succeeds → return computed value
6. If CAS fails (another client wrote first) → re-read from server and return that value

The `version: null` check means "only write if key doesn't exist" — ensures only one concurrent caller wins across multiple client instances. No cache stampede on cold start.

---

## Queue Methods

All work over both transports.

### `enqueue(payload: unknown, options?: QueueOptions): Promise<{ ok: true, id: number }>`

**Defaults:** `topic: "default"`, `delay: 0`, `maxAttempts: 3`.

```ts
const result = await kv.enqueue(
  { to: "user@example.com" },
  { topic: "emails", delay: 5_000, maxAttempts: 5 },
);
// { ok: true, id: 1 }
```

### `dequeue(topic?: string, limit?: number): Promise<QueueMessage[]>`

**Defaults:** `topic: "default"`, `limit: 1`.

Dequeue messages ready for delivery. Messages are moved to `"processing"` status on the server. Not acknowledging within 30s → auto-requeue (up to `maxAttempts`).

```ts
const messages = await kv.dequeue("emails", 10);

// Worker loop — acknowledge on success, skip on failure
for (const msg of messages) {
  try {
    await sendEmail(msg.payload);
    await kv.acknowledge(msg.id);  // mark as done
  } catch {
    // Don't acknowledge — requeued after 30s (up to maxAttempts)
    console.error(`Failed ${msg.id}, attempt ${msg.attempts + 1}/${msg.maxAttempts}`);
  }
}
```

### `acknowledge(id: number): Promise<boolean>`

```ts
const ok = await kv.acknowledge(message.id);
// true if message was found and acknowledged, false if already processed
```

**Message lifecycle (server-side):**
```
enqueue → pending → (dequeue) → processing → (acknowledge) → done
                                   ↓ not acked within 30s
                                requeue → pending (up to maxAttempts)
```

Failed message requeue runs every 60s on the server.

---

## Watch & Listen (require WebSocket — `open()` first)

Both throw `"WebSocket not connected. Call open() first."` if WebSocket is not open.

### `watch(keys: KvKey[], callback: (entries: (KvEntry | null)[]) => void): { cancel: () => void }`

Real-time key-change subscriptions. Fires immediately with current values, then on every mutation.

```ts
await kv.open();
const { cancel } = kv.watch(
  [["config", "theme"], ["config", "lang"]],
  (entries) => {
    // entries[0] = KvEntry | null for ["config", "theme"]
    // entries[1] = KvEntry | null for ["config", "lang"]
  },
);
cancel(); // unsubscribe — sends /kv/unwatch RPC
```

**Limitations:**
- Only ONE watch active per client — setting a new watch overwrites the previous callback.
- Cancel sends `/kv/unwatch` RPC.
- Fires the full set of current values for ALL watched keys (not just the changed one).
- Errors from callbacks are silently caught — won't break the WebSocket dispatch.

**Wire format (server → client push):**
```json
{ "type": "watch", "entries": [{ "key": [...], "value": ..., "version": ... } | null, ...] }
```

**Watch internals on server:** Uses `watchIndex: Map<hex-encoded-key, Set<Watcher>>`. On mutation (`set`/`delete`/`increment`/`atomic.commit`), `notifyWatchers(encodedKey)` fires all watchers for that key. Each watcher re-fetches ALL watched keys' current values on every fire.

### `listen(topic: string, callback: (msg: QueueMessage) => void): { cancel: () => void }`

Push-based queue message delivery. Server distributes messages round-robin across connected listeners (work-stealing).

```ts
await kv.open();
const { cancel } = kv.listen("emails", (msg) => {
  processEmail(msg.payload);
  kv.acknowledge(msg.id);  // must ack manually
});
cancel(); // sends /queue/unlisten RPC
```

**Limitations:**
- One callback per topic per client. Setting a new listener for the same topic overwrites the previous.
- Multiple topics can be listened to simultaneously (uses `Map<topic, callback>`).
- Server dispatch timer runs every 1s — messages experience up to ~1s latency.

**Wire format (server → client push):**
```json
{ "type": "queue", "topic": "emails", "message": { "id": 1, "payload": ..., "attempts": 0 } }
```

**Listen internals on server:** `queueListeners: Map<topic, Set<callback>>` with round-robin index per topic. `dispatchToListeners()` dequeues one message, distributes round-robin. Timer starts on first listener, stops when all topics have no listeners.

---

## Utility Methods

### `health(): Promise<{ ok: boolean, uptime: number }>`

Direct GET request — bypasses both REST and WebSocket transports. No auth required.

```ts
const status = await kv.health();
// { ok: true, uptime: 123.456 }
```

Uses `fetch(`${url}/health`)` directly, not the transport layer.

### `reset(): Promise<{ ok: true }>`

Deletes ALL data from `kv` and `queue` tables on the server. Clears all watchers. For testing only.

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
// After 2s, entries are expired — cleanExpired() removes them immediately
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
| Watch | — | Yes |
| Listen | — | Yes |
| Auto-fallback | — | Yes (on `close()` reverts to REST) |

**REST transport details:**
- All KV/queue methods use `fetch POST` to `{url}{path}` with `Authorization: Bearer {token}` header.
- Body: `JSON.stringify(params)`.
- Response: `res.json()`.
- On HTTP error status: throws `"KVS {path}: {status} {statusText}"`.
- `health()` uses raw `fetch GET {url}/health` — bypasses transport layer.

**WebSocket RPC details:**
- Counter `rpcId` starts at 0, increments per call, wraps via `++rpcId`.
- `rpcCallbacks: Map<number, { resolve, reject }>` stores pending promises by id.
- On message: if `data.id` exists → lookup callback. If `data.type === "watch"` → fire `watchCallback`. If `data.type === "queue"` → fire `queueCallbacks.get(topic)`.
- On close: rejects all pending promises with `"WebSocket closed"`, clears watch/queue subscriptions.
- Malformed messages silently ignored (try/catch in onmessage).

---

## Default Values Reference

| Method | Parameter | Default |
|---|---|---|
| `set(key, value, options)` | `options` | `{}` (no TTL) |
| `enqueue(payload, options)` | `options.topic` | `"default"` |
| | `options.delay` | `0` |
| | `options.maxAttempts` | `3` |
| `dequeue(topic, limit)` | `topic` | `"default"` |
| | `limit` | `1` |

---

## Singleflight (standalone)

Exported for deduplicating concurrent async work. Same API as `@coderbuzz/kvs`'s `Singleflight` but separate implementation.

```ts
import { Singleflight } from "@coderbuzz/kvs-client";

const sf = new Singleflight<User>();

// 100 concurrent calls for "user:42" — fetchUser() runs once
const user = await sf.do("user:42", () => fetchUser(42));

sf.size;           // number of in-flight keys
sf.clear();        // clear all in-flight
```

Used internally by `getAsync()`. Can also be used standalone for any deduplication needs.

---

## Gotchas

1. `open()` required for `watch()`/`listen()` — throws `"WebSocket not connected. Call open() first."` if not connected.
2. After `close()`, all subsequent calls revert to REST automatically.
3. Only ONE active `watch()` per client — calling `watch()` again overwrites the previous subscription.
4. One `listen()` callback per topic — calling `listen()` again for the same topic overwrites. Multiple topics can be active.
5. `listen()` callbacks must call `acknowledge()` manually — messages are NOT auto-acked.
6. `getAsync()` uses `JSON.stringify(key)` as singleflight dedup key. Uses atomic `check({ version: null })` for cross-process safety — two clients computing the same key: one wins, the other re-reads.
7. `health()` is the only method that bypasses auth — direct GET request, no transport layer.
8. `@coderbuzz/kvs` is a peer dependency — provides TypeScript types used by the client SDK. Must be installed alongside.
9. WebSocket auth happens via RPC `auth` method after connection (not in URL by default). Use `?token=` query param on the server side for pre-connect auth.
10. `Singleflight` in `kvs-client` is a separate class from the one in `kvs`. Same API, separate implementation.
11. No `increment` endpoint — the server doesn't expose a dedicated increment RPC. Use `get` + `set` or `atomic()` with version checks for atomic counters.
12. Queue dispatch timer runs every 1s on the server — `listen()` messages experience up to ~1s max latency.
13. Messages not acknowledged within 30s are auto-requeued by the server (up to `maxAttempts`).

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
| `dequeue` | POST | `/queue/dequeue` | `{ topic?, limit? }` |
| `acknowledge` | POST | `/queue/ack` | `{ id }` |
| `reset` | POST | `/kv/reset` | `{}` |
| `cleanExpired` | POST | `/kv/clean-expired` | `{}` |
| `health` | GET | `/health` | — (no body, no auth) |

**REST transport details:**
- All POST requests use `Content-Type: application/json` and `Authorization: Bearer {token}` headers.
- All POST responses are JSON parsed from `res.json()`.
- Non-2xx status → throws `Error("KVS {path}: {status} {statusText}")`.
- `health()` bypasses the transport layer entirely — uses raw `fetch(this.url + "/health")`.

**WebSocket RPC:** Same payload shapes sent as `{ id, method, params }` JSON-RPC messages. Responses come back as `{ id, result }` or `{ id, error }`.

---

## Transport Internals

### `_post(path, params)` — REST transport
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
- Synchronous in flow — one request at a time (no pipelining).
- Errors thrown synchronously on non-2xx status.

### `_rpc(path, params)` — WebSocket RPC
```ts
private _rpc(path: string, params: unknown): Promise<any> {
  const id = ++this.rpcId;
  return new Promise((resolve, reject) => {
    this.rpcCallbacks.set(id, { resolve, reject });
    this.ws!.send(JSON.stringify({ id, method: path, params }));
  });
}
```
- Increments `rpcId` (starts at 0, never resets, wraps via 64-bit overflow — practically unbounded).
- Stores `{ resolve, reject }` in `rpcCallbacks` Map keyed by `id`.
- Sends JSON-RPC request over WebSocket.
- Response routed via `onmessage` handler: lookup by `data.id`, call `resolve(data.result)` or `reject(data.error)`.

### Transport Switching
- Constructor sets `this._transport = this._post.bind(this)` — REST is default.
- `open()` on success sets `this._transport = this._rpc.bind(this)` — switches to WebSocket.
- `close()` sets `this._transport = this._post.bind(this)` — reverts to REST.
- All public methods call `await this._transport(path, params)` — transport-agnostic.

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
    this.watchCallback?.(data.entries);        // fire watch callback
  } else if (data.type === "queue") {
    this.queueCallbacks.get(data.topic)?.(data.message);  // fire listener callback
  }
  // Malformed JSON silently ignored via catch
};
```

### WebSocket `onclose` Handler
```ts
ws.onclose = () => {
  this.ws = null;
  this._transport = this._post.bind(this);     // fallback to REST
  this.watchCallback = null;                    // clear watch
  this.queueCallbacks.clear();                  // clear all listeners
  for (const cb of this.rpcCallbacks.values()) {
    cb.reject(new Error("WebSocket closed"));   // reject all pending
  }
  this.rpcCallbacks.clear();
};
```

---

## Push Event Flow

### Watch Flow
```
Client: watch(keys, callback)
  → ws.send({ method: "/kv/watch", params: { keys } })
  → sets this.watchCallback = callback
     (overwrites previous if any)

Server: registers watcher in store.watchIndex
  → immediately fires current values
  → on any mutation to watched keys → fires again

Push message (server → client):
{ "type": "watch", "entries": [entry|null, ...] }

Client onmessage:
  → data.type === "watch" → this.watchCallback?.(data.entries)

Cancel:
  client: ws.send({ method: "/kv/unwatch" })
  → client: this.watchCallback = null
  → server: removes watcher from watchIndex
```

### Listen Flow
```
Client: listen(topic, callback)
  → ws.send({ method: "/queue/listen", params: { topic } })
  → sets this.queueCallbacks.set(topic, callback)
     (overwrites previous for same topic, allows multiple topics)

Server: registers listener in store.queueListeners
  → dispatch timer (1s) dequeues messages round-robin

Push message (server → client):
{ "type": "queue", "topic": "...", "message": QueueMessage }

Client onmessage:
  → data.type === "queue" → this.queueCallbacks.get(data.topic)?.(data.message)

Cancel:
  client: ws.send({ method: "/queue/unlisten", params: { topic } })
  → client: this.queueCallbacks.delete(topic)
  → server: removes listener from queueListeners
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
- Server sends malformed response without matching `id` (orphaned, never resolved — potential memory leak if server is buggy)

---

## Server & Client Packages

- `@coderbuzz/kvs` — the embeddable store engine (SQLite/PostgreSQL) used by the server
- `@coderbuzz/kvs-server` — wraps the store into HTTP REST + WebSocket server
- `@coderbuzz/kvs-client` — this package, the TypeScript SDK for the server
