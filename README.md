<!-- docs: sync from coderbuzz/codex@c0ec729 -->

# KVS Client &mdash; `@coderbuzz/kvs-client`

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

Works with `@coderbuzz/kvs` as a peer dependency for TypeScript types. Pair with `@coderbuzz/kvs-server` on the backend.

---

## Features

- **REST-first** — works immediately after construction, no setup required
- **WebSocket RPC** — lower latency with `open()`, auto-fallback to REST on disconnect
- **getAsync** — cache-with-compute pattern with singleflight deduplication + cross-process safety
- **Atomic operations** — fluent builder for multi-key transactions with version checks
- **Watch** — real-time key-change subscriptions (requires WebSocket)
- **Listen** — push-based queue delivery with work-stealing (requires WebSocket)
- **Health check** — unauthenticated server health endpoint
- **All types included** — no need to import from `@coderbuzz/kvs` for type usage

---

## Installation

```sh
npm install @coderbuzz/kvs @coderbuzz/kvs-client
```

---

## Quick Start

```ts
import { KvsClient } from "@coderbuzz/kvs-client";

const kv = new KvsClient({
  url: "http://localhost:3000",
  token: "your-access-token",
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
    await kv.acknowledge(msg.id);
  } catch {
    // Don't ack — auto-requeued after 30s
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
kv.listen("emails", (msg) => {
  processEmail(msg.payload);
  kv.acknowledge(msg.id);
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

The `version: null` check ensures only one concurrent caller wins — safe across multiple client instances.

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
  console.log("Check failed — retry");
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

All work over both transports.

### `enqueue(payload: unknown, options?: QueueOptions): Promise<{ ok: true, id: number }>`

**Defaults:** `topic: "default"`, `delay: 0`, `maxAttempts: 3`.

```ts
const result = await kv.enqueue(
  { to: "user@example.com", subject: "Welcome" },
  { topic: "emails", delay: 5_000, maxAttempts: 5 },
);
// { ok: true, id: 1 }
```

### `dequeue(topic?: string, limit?: number): Promise<QueueMessage[]>`

**Defaults:** `topic: "default"`, `limit: 1`.

Dequeue messages ready for delivery. Messages are moved to `"processing"` status on the server. Not acknowledged within 30s → auto-requeued (up to `maxAttempts`).

```ts
const messages = await kv.dequeue("emails", 10);

// Worker loop — acknowledge on success, skip on failure
for (const msg of messages) {
  try {
    await sendEmail(msg.payload);
    await kv.acknowledge(msg.id); // mark as done
  } catch {
    // Don't acknowledge — auto-requeued after 30s (up to maxAttempts)
  }
}
```

### `acknowledge(id: number): Promise<boolean>`

```ts
const ok = await kv.acknowledge(message.id);
// true if found and acknowledged, false if already processed
```

**Message lifecycle (server-side):**
```
pending → (dequeue) → processing → (acknowledge) → done
                           ↓ not acked within 30s
                        requeue → pending (up to maxAttempts)
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
1. Idempotent — returns immediately if WebSocket already connected
2. Connects to `ws://host:port/ws` (derived from `url`, `http` → `ws`)
3. Sends auth RPC `{ id, method: "auth", params: { token } }`
4. On success: switches transport to WebSocket RPC
5. On failure: throws `"WebSocket authentication failed"`

### `close(): void`

Disconnect WebSocket and revert to REST transport. Cancels active watch/listen subscriptions.

```ts
kv.close();
// All subsequent calls revert to REST automatically
// Active watch callback is cleared, queue listeners are removed
```

### `watch(keys: KvKey[], callback: (entries: (KvEntry | null)[]) => void): { cancel: () => void }`

Subscribe to real-time key-change notifications. Fires immediately with current values, then on every mutation. **Requires `open()`.**

```ts
await kv.open();

const { cancel } = kv.watch(
  [["config", "theme"], ["config", "lang"]],
  (entries) => {
    // entries[0] = KvEntry | null for ["config", "theme"]
    // entries[1] = KvEntry | null for ["config", "lang"]
    applyTheme(entries[0]?.value);
    setLanguage(entries[1]?.value);
  },
);

cancel(); // unsubscribe — sends /kv/unwatch RPC
```

**Limitations:**
- Only ONE active `watch()` per client — calling again overwrites the previous subscription.
- Fires the full set of current values for ALL watched keys (not just the changed one).

### `listen(topic: string, callback: (msg: QueueMessage) => void): { cancel: () => void }`

Push-based queue message delivery. Server distributes messages round-robin across all connected listeners. **Requires `open()`.**

```ts
await kv.open();

const { cancel } = kv.listen("emails", (msg) => {
  processEmail(msg.payload);
  kv.acknowledge(msg.id); // must ack manually
});

cancel(); // unsubscribe — sends /queue/unlisten RPC
```

**Limitations:**
- One callback per topic per client — calling again for the same topic overwrites the previous.
- Multiple topics can be listened to simultaneously.
- Server dispatch timer runs every 1 s — messages are not instant (~1s max latency).
- Messages distributed round-robin across all connected listeners (work-stealing).

---

## Utility Methods

### `health(): Promise<{ ok: boolean, uptime: number }>`

Direct GET request — bypasses both REST and WebSocket transports. No auth required.

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
// After 2s, entries are expired on server — cleanExpired() removes them immediately
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
| Watch | — | Yes |
| Listen | — | Yes |
| Auto-fallback | — | Yes (on `close()` reverts to REST) |

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

## Types

All types are re-exported from `@coderbuzz/kvs-client` — no need to import from `@coderbuzz/kvs`:

```ts
import type {
  KvKey,           // KvKeyPart[]
  KvKeyPart,       // string | number | bigint | boolean | Uint8Array
  KvEntry,         // { key, value, version }
  KvCommitResult,  // { ok: true, version }
  KvCommitError,   // { ok: false }
  KvCheck,         // { key, version }
  KvMutation,      // { type: "set"|"delete", key, value?, ttl? }
  KvListSelector,  // { prefix?, start?, end? }
  KvListOptions,   // { limit?, cursor?, reverse? }
  KvListResult,    // { entries, cursor }
  QueueMessage,    // { id, topic, payload, enqueuedAt, deliverAt, attempts, maxAttempts }
  QueueOptions,    // { topic?, delay?, maxAttempts? }
} from "@coderbuzz/kvs-client";
```

| Type | Fields |
|---|---|
| `KvKey` | `KvKeyPart[]` |
| `KvKeyPart` | `string \| number \| bigint \| boolean \| Uint8Array` |
| `KvEntry` | `{ key: KvKey, value: unknown, version: number }` |
| `KvCommitResult` | `{ ok: true, version: number }` |
| `KvCommitError` | `{ ok: false }` |
| `KvCheck` | `{ key: KvKey, version: number \| null }` — `null` = "must not exist" |
| `KvMutation` | `{ type: "set" \| "delete", key: KvKey, value?: unknown, ttl?: number }` |
| `KvListSelector` | `{ prefix?: KvKey, start?: KvKey, end?: KvKey }` |
| `KvListOptions` | `{ limit?: number, cursor?: string, reverse?: boolean }` |
| `KvListResult` | `{ entries: KvEntry[], cursor: string \| null }` |
| `QueueMessage` | `{ id, topic, payload, enqueuedAt, deliverAt, attempts, maxAttempts }` |
| `QueueOptions` | `{ topic?: string, delay?: number, maxAttempts?: number }` |

---

## Gotchas

1. `open()` required for `watch()`/`listen()` — throws `"WebSocket not connected. Call open() first."` if not connected.
2. Only ONE active `watch()` per client — calling `watch()` again overwrites the previous subscription.
3. One `listen()` callback per topic — calling `listen()` again for the same topic overwrites. Multiple topics can be active simultaneously.
4. `listen()` callbacks must call `acknowledge()` manually — messages are NOT auto-acked.
5. After `close()`, all subsequent KV/queue calls revert to REST automatically. Active watch/listen subscriptions are cancelled.
6. `getAsync()` uses `JSON.stringify(key)` as singleflight dedup key — same array in same order. Uses atomic `check({ version: null })` for cross-process safety.
7. `health()` is the only method that bypasses auth — direct GET request, no transport layer.
8. `@coderbuzz/kvs` is a peer dependency — provides TypeScript types. Must be installed alongside.
9. Queue dispatch timer runs every 1s on the server — `listen()` messages experience up to 1s latency.
10. No `increment` endpoint — use `get` + `set` or `atomic()` for atomic counters.

---

## Wire Format Reference

### WebSocket RPC (client → server)

```json
{ "id": 1, "method": "/kv/get", "params": { "key": ["users", "alice"] } }
{ "id": 2, "method": "/kv/set", "params": { "key": ["counter"], "value": 42, "ttl": 60000 } }
{ "id": 3, "method": "/kv/atomic", "params": { "checks": [...], "mutations": [...], "enqueues": [...] } }
{ "id": 4, "method": "/queue/enqueue", "params": { "payload": {...}, "topic": "emails", "delay": 5000 } }
{ "id": 5, "method": "/kv/watch", "params": { "keys": [["config", "theme"], ["config", "lang"]] } }
{ "id": 6, "method": "/kv/unwatch" }
{ "id": 7, "method": "/queue/listen", "params": { "topic": "emails" } }
{ "id": 8, "method": "/queue/unlisten", "params": { "topic": "emails" } }
```

### Server → Client Response

```json
{ "id": 1, "result": { "entry": { "key": [...], "value": ..., "version": 1 } } }
{ "id": 1, "error": "Error message" }
```

### Push Events (unsolicited, no `id`)

```json
{ "type": "watch", "entries": [{ "key": [...], "value": ..., "version": 1 }, null] }
{ "type": "queue", "topic": "emails", "message": { "id": 1, "payload": ..., "attempts": 0 } }
```

---

## License

MIT &copy; 2026 Indra Gunawan
