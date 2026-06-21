<!-- docs: sync from coderbuzz/codex@4b7f24c -->

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
import { KvsClient, type KvsClientOptions, Singleflight, AtomicBuilder } from "@coderbuzz/kvs-client";

// Types re-exported from @coderbuzz/kvs:
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

// Paginated
const page1 = await kv.list({ prefix: ["logs"] }, { limit: 20 });
const page2 = await kv.list({ prefix: ["logs"] }, { limit: 20, cursor: page1.cursor });

// Reverse
await kv.list({ prefix: ["logs"] }, { limit: 5, reverse: true });
```

### `atomic(): AtomicBuilder`

Returns a fluent builder. `commit()` is the terminal async method.

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

**AtomicBuilder methods:** `check()`, `set()`, `delete()`, `enqueue()` — all return `this`. `commit(): Promise<KvCommitResult | KvCommitError>`.

### `getAsync<T>(key: KvKey, fn: () => T | Promise<T>, ttl?: number): Promise<T>`

Cache-with-compute with singleflight deduplication and cross-process safety.

```ts
const ad = await kv.getAsync(["ads", "venue", 42], () => fetchNextAd(42), 30_000);
```

**Algorithm:**
1. Check server cache via `get(key)` — return immediately on hit
2. Singleflight dedup within process (`this.sf.do(JSON.stringify(key), ...)`)
3. Call `fn()` exactly once
4. Atomic check-and-set: `check({ key, version: null }).set(key, value, { ttl }).commit()`
5. If CAS succeeds → return computed value
6. If CAS fails (another client wrote first) → re-read from server and return that

The `version: null` check means "only write if key doesn't exist" — ensures only one concurrent caller wins.

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

```ts
const messages = await kv.dequeue("emails", 10);
// QueueMessage[]
```

### `acknowledge(id: number): Promise<boolean>`

```ts
const ok = await kv.acknowledge(message.id);
// true if message was found and acknowledged
```

---

## Watch & Listen (require WebSocket — `open()` first)

Both throw `"WebSocket not connected. Call open() first."` if WebSocket is not open.

### `watch(keys: KvKey[], callback: (entries: (KvEntry | null)[]) => void): { cancel: () => void }`

Real-time key-change subscriptions. Fires immediately with current values.

```ts
await kv.open();
const { cancel } = kv.watch(
  [["config", "theme"], ["config", "lang"]],
  (entries) => {
    // entries[0] = KvEntry | null for ["config", "theme"]
    // entries[1] = KvEntry | null for ["config", "lang"]
  },
);
cancel(); // unsubscribe
```

**Limitations:**
- Only ONE watch active per client — setting a new watch overwrites the previous callback.
- Cancel sends `/kv/unwatch` RPC.

**Wire format (server → client push):**
```json
{ "type": "watch", "entries": [{ "key": [...], "value": ..., "version": ... } | null, ...] }
```

### `listen(topic: string, callback: (msg: QueueMessage) => void): { cancel: () => void }`

Push-based queue message delivery. Server distributes messages round-robin across connected listeners.

```ts
await kv.open();
const { cancel } = kv.listen("emails", (msg) => {
  processEmail(msg.payload);
  kv.acknowledge(msg.id);  // must ack manually
});
cancel();
```

**Limitations:**
- One callback per topic per client. Setting a new listener for the same topic overwrites the previous.
- Multiple topics can be listened to simultaneously (uses `Map<topic, callback>`).

**Wire format (server → client push):**
```json
{ "type": "queue", "topic": "emails", "message": { "id": 1, "payload": ..., ... } }
```

---

## Utility Methods

### `health(): Promise<{ ok: boolean, uptime: number }>`

Direct GET request — bypasses both REST and WebSocket transports. No auth required.

```ts
const status = await kv.health();
// { ok: true, uptime: 123.456 }
```

### `reset(): Promise<{ ok: true }>`

Deletes ALL data. For testing only.

### `cleanExpired(): Promise<{ ok: true, deleted: number }>`

Manually expire stale KV entries. Returns count of deleted rows.

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

---

## Default Values Reference

| Method | Parameter | Default |
|---|---|---|
| `dequeue(topic, limit)` | `topic` | `"default"` |
| | `limit` | `1` |
| `enqueue(payload, options)` | `options.topic` | `"default"` |
| | `options.delay` | `0` |
| | `options.maxAttempts` | `3` |

---

## Gotchas

1. `open()` required for `watch()`/`listen()` — throws if WebSocket not connected.
2. After `close()`, all subsequent calls revert to REST automatically.
3. Only ONE active `watch()` per client — calling `watch()` again overwrites the previous subscription.
4. One `listen()` callback per topic — calling `listen()` again for the same topic overwrites.
5. `listen()` callbacks must `acknowledge()` manually — messages are NOT auto-acked.
6. `getAsync` uses `JSON.stringify(key)` as singleflight dedup key. Uses atomic `check({ version: null })` for cross-process safety — two clients computing the same key: one wins, the other re-reads.
7. `health()` is the only method that bypasses auth — direct GET request.
8. `@coderbuzz/kvs` is a peer dependency — provides TypeScript types used by the client SDK. Must be installed alongside.
9. WebSocket auth happens via RPC `auth` method after connection (not in URL by default). Use `?token=` query param for pre-connect auth.
10. `Singleflight` in `kvs-client` is a separate class from the one in `kvs`. Same API, separate implementation.
