<!-- docs: sync from coderbuzz/codex@15d78e0 -->

# KVS Client: `@coderbuzz/kvs-client`

> **TypeScript client SDK for `@coderbuzz/kvs-server`.** REST-first, transparently upgrades to WebSocket RPC. Watch keys in real-time, listen to queue push delivery.
> AI agents: see [AI_KNOWLEDGE.md](https://github.com/coderbuzz/kvs-client/blob/main/AI_KNOWLEDGE.md) for expert context.
<p align="center">
  <a href="https://www.npmjs.com/package/@coderbuzz/kvs-client"><img src="https://img.shields.io/npm/v/@coderbuzz/kvs-client.svg?style=flat-square" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@coderbuzz/kvs-client"><img src="https://img.shields.io/npm/dm/@coderbuzz/kvs-client.svg?style=flat-square" alt="npm downloads" /></a>
  <a href="https://github.com/coderbuzz/kvs-client/blob/main/LICENSE"><img src="https://img.shields.io/github/license/coderbuzz/kvs-client.svg?style=flat-square" alt="MIT License" /></a>
  <a href="https://github.com/coderbuzz/kvs-client"><img src="https://img.shields.io/github/stars/coderbuzz/kvs-client.svg?style=flat-square" alt="GitHub Stars" /></a>
  <a href="https://github.com/coderbuzz/kvs-client/actions/workflows/ci.yml"><img src="https://github.com/coderbuzz/kvs-client/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://codecov.io/gh/coderbuzz/kvs-client"><img src="https://codecov.io/gh/coderbuzz/kvs-client/graph/badge.svg" alt="Codecov" /></a>
</p>

KVS Client is a fetch-based TypeScript SDK for communicating with a `@coderbuzz/kvs-server` instance. Works immediately over REST after construction. After calling `open()` it transparently upgrades to WebSocket JSON-RPC for lower latency. Same API over both transports.

Has no dependencies or peer dependencies: it ships its own copies of the KVS types. Pair with `@coderbuzz/kvs-server` on the backend.

---

## Features

- **REST-first**: works immediately after construction, no setup required
- **WebSocket RPC**: lower latency with `open()`, REST fallback on disconnect
- **Optional recovery**: exponential-backoff reconnect restores watch/listen subscriptions and refreshes the current snapshot
- **getAsync**: cache-with-compute pattern with singleflight deduplication + cross-process safety
- **Atomic operations**: fluent builder for multi-key transactions with version checks
- **Watch**: real-time key-change subscriptions (requires WebSocket)
- **Listen**: push-based queue delivery with work-stealing (requires WebSocket)
- **Health check**: unauthenticated server health endpoint
- **All types included**: no need to import from `@coderbuzz/kvs` for type usage

---

## Installation

```sh
npm install @coderbuzz/kvs-client
```

---

## Quick Start

```ts
import { KvsClient } from "@coderbuzz/kvs-client";

const kv = new KvsClient({
  url: "http://localhost:3000",
  token: "your-access-token",
  autoReconnect: true,
});

// REST transport (always available)
await kv.set(["greeting"], "hello world");
const entry = await kv.get(["greeting"]);

// Atomic counters via set (increment not exposed as separate endpoint)
const current = (await kv.get(["counter"]))?.value as number ?? 0;
await kv.set(["counter"], current + 1);

// Atomic transactions with version checks
const result = await kv.atomic()
  .check({ key: ["counter"], version: 1 })
  .set(["counter"], 2)
  .commit();

// Queue with retries
await kv.enqueue({ email: "user@example.com" }, { topic: "emails" });
const msgs = await kv.dequeue("emails", 10);
for (const msg of msgs) {
  try {
    await sendEmail(msg.payload);
    await kv.acknowledge(msg.id, msg.token);
  } catch (error) {
    await kv.nack(msg.id, msg.token, { error: String(error) }); // retried after a backoff
  }
}

// Upgrade to WebSocket RPC for lower latency + watch/listen
await kv.open();
await kv.set(["greeting"], "hello ws"); // now over WebSocket

// Real-time watch
const { cancel } = kv.watch([["config", "theme"]], (entries) => {
  console.log("Theme changed:", entries[0]?.value);
});

// Push-based queue listener
kv.listen("emails", async (msg) => {
  await processEmail(msg.payload); // resolves → acked, throws → retried
});

kv.close(); // revert to REST
```

---

## Constructor

### `new KvsClient(options: KvsClientOptions)`

| Option | Type | Default | Description |
|---|---|---|---|
| `url` | `string` | required | Server base URL (e.g. `http://localhost:3000`). Trailing slashes are stripped. |
| `token` | `string` | required | Bearer access token for authentication |
| `autoReconnect` | `boolean` | `false` | Reconnect after an unexpected close and restore watch/listen subscriptions. |
| `reconnectMinDelayMs` | `number` | `250` | Initial reconnect delay; values below 50 ms are clamped to 50 ms. |
| `reconnectMaxDelayMs` | `number` | `10000` | Maximum reconnect delay; clamped to at least `reconnectMinDelayMs`. |

```ts
const kv = new KvsClient({ url: "http://localhost:3000", token: "secret" });
```

Initializes REST transport (`fetch`-based POST). WebSocket state is `null` until `open()` is called.

---

## KV Methods

All methods work over both REST and WebSocket (auto-selected based on `open()` state).

### `get(key: KvKey): Promise<KvEntry | null>`

```ts
const entry = await kv.get(["users", "alice"]);
// { key: ["users", "alice"], value: { name: "Alice" }, version: 1 }
// null if missing or expired
```

### `set(key: KvKey, value: unknown, options?: { ttl?: number }): Promise<KvCommitResult>`

```ts
const result = await kv.set(["users", "alice"], { name: "Alice" });
// { ok: true, version: 1 }

await kv.set(["cache", "key"], value, { ttl: 60_000 }); // expires in 60 s
```

Every `set` increments `version` by 1. TTL is in milliseconds.

### `delete(key: KvKey): Promise<{ ok: true }>`

```ts
await kv.delete(["users", "alice"]);
// { ok: true }
```

### `list(selector: KvListSelector, options?: KvListOptions): Promise<KvListResult>`

**Defaults:** `limit: 100`, max `1000`, ascending, `reverse: false`. `cursor` is opaque base64.

```ts
// Prefix query
await kv.list({ prefix: ["users"] });

// Range query
await kv.list({ start: ["events", 1000], end: ["events", 2000] });

// Paginated
const page1 = await kv.list({ prefix: ["logs"] }, { limit: 20 });
const page2 = await kv.list({ prefix: ["logs"] }, { limit: 20, cursor: page1.cursor });

// Reverse
await kv.list({ prefix: ["logs"] }, { limit: 5, reverse: true });
```

**`KvListResult`:** `{ entries: KvEntry[], cursor: string | null }`

### `getAsync<T>(key: KvKey, fn: () => T | Promise<T>, ttl?: number): Promise<T>`

Cache-with-compute pattern with singleflight deduplication and cross-process safety:

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

The `version: null` check ensures only one concurrent writer wins. Across multiple client instances `fn()` may run once per instance, but every caller returns the value that was stored first.

### `atomic(): AtomicBuilder`

Fluent builder for version-checked transactions:

```ts
const result = await kv.atomic()
  .check({ key: ["counter"], version: 3 })       // fail if not at version 3
  .check({ key: ["new-key"], version: null })     // fail if key exists
  .set(["counter"], 4)
  .set(["meta"], { updatedAt: Date.now() }, { ttl: 3_600_000 })
  .delete(["old-key"])
  .enqueue({ task: "notify" }, { topic: "jobs" })
  .commit();

if (result.ok) {
  console.log("Version:", result.version);
} else {
  console.log("Check failed, retry");
}
```

| Method | Signature | Description |
|---|---|---|
| `check` | `(...checks: KvCheck[]): this` | Assert key versions. `version: null` = "must not exist". `version: N` = "must be at version N". |
| `set` | `(key, value, options?): this` | `options: { ttl?: number }` |
| `delete` | `(key): this` | |
| `enqueue` | `(payload, options?): this` | `options: QueueOptions` |
| `commit` | `(): Promise<KvCommitResult \| KvCommitError>` | Execute all operations atomically. Returns `{ ok: false }` if any check fails. |

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

## WebSocket Methods

### `open(): Promise<void>`

Connect WebSocket, authenticate, and switch all KV/queue calls to RPC for lower latency.

```ts
await kv.open();
// All subsequent KV/queue calls now go over WebSocket
// Required for watch() and listen()
```

**Process:**
1. Idempotent and singleflight: concurrent callers share one connection attempt
2. Connects to `ws://host:port/ws` (derived from `url`, `http` → `ws`)
3. Sends auth RPC `{ id, method: "auth", params: { token } }`
4. On success: switches transport to WebSocket RPC
5. On failure: rejects with `"WebSocket connection failed"` (socket error) or the server's auth error (`"Unauthorized"`, after which the server closes the socket)

With `autoReconnect: true`, an unexpected close immediately returns ordinary KV/queue calls to REST, rejects in-flight RPCs, and schedules reconnect with exponential backoff plus 0.75–1.25 jitter. After authentication, the client restores its watch and queue listeners. Explicit `close()` never reconnects.

### `close(): void`

Disconnect WebSocket and revert to REST transport. Cancels active watch/listen subscriptions.

```ts
kv.close();
// All subsequent calls revert to REST automatically
// Active watch callback is cleared, queue listeners are removed
```

### `watch(keys: KvKey[], callback: (entries: (KvEntry | null)[], event?: KvWatchEvent) => void): { cancel: () => void }`

Subscribe to real-time key-change notifications. Fires immediately with current values, then on every mutation. **Requires `open()`.**

```ts
await kv.open();

const { cancel } = kv.watch(
  [["config", "theme"], ["config", "lang"]],
  (entries, event) => {
    // entries[0] = KvEntry | null for ["config", "theme"]
    // entries[1] = KvEntry | null for ["config", "lang"]
    applyTheme(entries[0]?.value);
    setLanguage(entries[1]?.value);
    if (event?.reset) console.log("Server store was reset");
  },
);

cancel(); // unsubscribe: sends /kv/unwatch RPC
```

**Limitations:**
- Only ONE active `watch()` per client: calling again overwrites the previous subscription.
- Fires the full set of current values for ALL watched keys (not just the changed one).
- `event.sequence` is monotonic within one server process. Decreasing sequences on the same connection are ignored; sequence tracking resets after reconnect.
- Reconnect recovery is snapshot-based: re-subscription immediately returns current values, covering changes made while offline.

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

---

## Utility Methods

### `health(): Promise<{ ok: boolean, uptime: number }>`

Direct GET request. Bypasses both REST and WebSocket transports. No auth required.

```ts
const status = await kv.health();
// { ok: true, uptime: 123.456 }
```

### `reset(): Promise<{ ok: true }>`

Deletes ALL data from `kv` and `queue` tables on the server. For testing only.

```ts
await kv.reset();
await kv.get(["users", "alice"]); // null
```

### `cleanExpired(): Promise<{ ok: true, deleted: number }>`

Manually expire stale KV entries on the server. Returns count of deleted rows.

```ts
await kv.set(["cache", "a"], "x", { ttl: 1000 });
await kv.set(["cache", "b"], "y", { ttl: 1000 });
// After 2s, entries are expired on server: cleanExpired() removes them immediately
const data = await kv.cleanExpired();
// { ok: true, deleted: 2 }
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
      │   _post (REST)  │              │   _rpc (WebSocket)  │
      │   fetch POST    │              │  JSON-RPC via WS    │
      │   to url+path   │              │  {id,method,params} │
      └─────────────────┘              └─────────────────────┘
           DEFAULT                           AFTER open()
```

| Feature | REST | WebSocket RPC |
|---|---|---|
| Default | Yes | No (requires `open()`) |
| Latency | Request-response | Lower (persistent connection) |
| Watch | N/A | Yes |
| Listen | N/A | Yes |
| Disconnect behavior | Remains available | RPCs fall back to REST; reconnect is optional |

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

## Types

All types are re-exported from `@coderbuzz/kvs-client`. No need to import from `@coderbuzz/kvs`:

```ts
import type {
  KvKey,           // KvKeyPart[]
  KvKeyPart,       // string | number | bigint | boolean | Uint8Array
  KvEntry,         // { key, value, version }
  KvWatchEvent,    // { sequence?, reset? }
  KvCommitResult,  // { ok: true, version }
  KvCommitError,   // { ok: false }
  KvCheck,         // { key, version }
  KvMutation,      // { type: "set"|"delete", key, value?, ttl? }
  KvListSelector,  // { prefix?, start?, end? }
  KvListOptions,   // { limit?, cursor?, reverse? }
  KvListResult,    // { entries, cursor }
  QueueMessage,    // { id, topic, payload, enqueuedAt, deliverAt, attempts, maxAttempts, token, lockedUntil, lastError }
  QueueDeadMessage,// { id, topic, payload, …, lastError, failedAt }
  QueueOptions,    // { topic?, delay?, maxAttempts? }
  QueueNackOptions,   // { error?, delay? }
  QueueListenOptions, // { concurrency?, visibilityTimeout?, autoAck? }
  QueueStats,      // { topic, pending, delayed, processing, dead, done, oldestPendingAt }
} from "@coderbuzz/kvs-client";
```

| Type | Fields |
|---|---|
| `KvKey` | `KvKeyPart[]` |
| `KvKeyPart` | `string \| number \| bigint \| boolean \| Uint8Array` |
| `KvEntry` | `{ key: KvKey, value: unknown, version: number }` |
| `KvWatchEvent` | `{ sequence?: number, reset?: boolean }` |
| `KvCommitResult` | `{ ok: true, version: number }` |
| `KvCommitError` | `{ ok: false }` |
| `KvCheck` | `{ key: KvKey, version: number \| null }`: `null` = "must not exist" |
| `KvMutation` | `{ type: "set" \| "delete", key: KvKey, value?: unknown, ttl?: number }` |
| `KvListSelector` | `{ prefix?: KvKey, start?: KvKey, end?: KvKey }` |
| `KvListOptions` | `{ limit?: number, cursor?: string, reverse?: boolean }` |
| `KvListResult` | `{ entries: KvEntry[], cursor: string \| null }` |
| `QueueMessage` | `{ id, topic, payload, enqueuedAt, deliverAt, attempts, maxAttempts, token, lockedUntil, lastError }` |
| `QueueDeadMessage` | `{ id, topic, payload, enqueuedAt, deliverAt, attempts, maxAttempts, lastError, failedAt }` |
| `QueueNackOptions` | `{ error?: string, delay?: number }` |
| `QueueListenOptions` | `{ concurrency?: number, visibilityTimeout?: number, autoAck?: boolean }` |
| `QueueStats` | `{ topic, pending, delayed, processing, dead, done, oldestPendingAt }` |
| `QueueOptions` | `{ topic?: string, delay?: number, maxAttempts?: number }` |

---

## Gotchas

1. `open()` required for `watch()`/`listen()`: throws `"WebSocket not connected. Call open() first."` if not connected.
2. Only ONE active `watch()` per client: calling `watch()` again overwrites the previous subscription.
3. One `listen()` callback per topic: calling `listen()` again for the same topic overwrites. Multiple topics can be active simultaneously.
4. `listen()` handlers are awaited and auto-acked (resolve) or nacked (throw). Do not also call `acknowledge()` in them, or pass `autoAck: false`.
5. Explicit `close()` reverts to REST, cancels reconnect, and removes watch/listen subscriptions. With `autoReconnect: true`, only unexpected closes preserve and restore subscriptions.
6. `getAsync()` uses `JSON.stringify(key)` as singleflight dedup key: same array in same order. Uses atomic `check({ version: null })` for cross-process safety.
7. `health()` is the only method that bypasses auth: direct GET request, no transport layer.
8. No dependency on `@coderbuzz/kvs`: all types are bundled in this package. `KvWatchEvent` here is `{ sequence?, reset? }`, a subset of the store's type.
9. New messages (including `atomic()` enqueues) are pushed at once; delayed messages, retries and expired leases within about a second.
10. No `increment` endpoint: use `get` + `set` or `atomic()` for atomic counters.
11. `watch()` and `listen()` send their request without an `id`, so a server-side rejection (too many keys, forbidden key or topic) is not reported: no events arrive and no error is thrown.

---

## Wire Format Reference

### WebSocket RPC (client → server)

```json
{ "id": 1, "method": "/kv/get", "params": { "key": ["users", "alice"] } }
{ "id": 2, "method": "/kv/set", "params": { "key": ["counter"], "value": 42, "ttl": 60000 } }
{ "id": 3, "method": "/kv/atomic", "params": { "checks": [...], "mutations": [...], "enqueues": [...] } }
{ "id": 4, "method": "/queue/enqueue", "params": { "payload": {...}, "topic": "emails", "delay": 5000 } }
{ "id": 5, "method": "auth", "params": { "token": "..." } }

// Sent without id (no response expected)
{ "method": "/kv/watch", "params": { "keys": [["config", "theme"], ["config", "lang"]] } }
{ "method": "/kv/unwatch" }
{ "method": "/queue/listen", "params": { "topic": "emails", "concurrency": 4 } }
{ "method": "/queue/unlisten", "params": { "topic": "emails" } }
```

### Server → Client Response

```json
{ "id": 1, "result": { "entry": { "key": [...], "value": ..., "version": 1 } } }
{ "id": 1, "error": "Error message" }
```

### Push Events (unsolicited, no `id`)

```json
{ "type": "watch", "entries": [{ "key": [...], "value": ..., "version": 1 }, null], "sequence": 42 }
// "reset": true is present only on reset tombstone snapshots
{ "type": "queue", "topic": "emails", "message": { "id": 1, "payload": ..., "attempts": 1, "token": "3f0c6c1e-...", "lockedUntil": 1700000030000 } }
```

---

## License

MIT &copy; 2026 Indra Gunawan
