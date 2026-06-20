<!-- docs: sync from coderbuzz/codex@7af404c -->

# KVS Client — AI Agent Knowledge File

**Package:** `@coderbuzz/kvs-client` v0.2.6
**Purpose:** TypeScript client SDK for `@coderbuzz/kvs-server`. REST + WebSocket RPC.
**Distribution:** ESM only (`dist/index.js` + `dist/index.d.ts`).

---

## Mental Model

KVS Client talks to a `@coderbuzz/kvs-server` instance. REST by default, WebSocket RPC after `open()`.

```
KvsClient
  ├── REST transport (default)
  └── WebSocket RPC (after open())
        ├── All KV/queue methods
        ├── watch()   — real-time key subscriptions
        └── listen()  — push queue delivery
```

---

## Complete Import

```ts
import { KvsClient, type KvsClientOptions, Singleflight, AtomicBuilder } from "@coderbuzz/kvs-client";
import type { KvKey, KvEntry, KvCommitResult, KvListResult, QueueMessage, QueueOptions } from "@coderbuzz/kvs-client";
// Types also re-exported from @coderbuzz/kvs
```

---

## Key Methods

- `new KvsClient({ url, token })` — constructor, REST transport
- `await kv.get(key)` → `KvEntry | null`
- `await kv.set(key, value, { ttl? })` → `{ ok, version }`
- `await kv.delete(key)` → `{ ok }`
- `await kv.list(selector, options?)` → `{ entries, cursor }`
- `await kv.atomic().check().set().enqueue().commit()` → fluent atomic
- `await kv.enqueue(payload, options?)` → `{ ok, id }`
- `await kv.dequeue(topic?, limit?)` → `QueueMessage[]`
- `await kv.acknowledge(id)` → `boolean`
- `await kv.health()` → `{ ok, uptime }`
- `await kv.reset()` → `{ ok }`
- `await kv.cleanExpired()` → `{ ok, deleted }`
- `await kv.open()` — connect WebSocket, authenticate, switch transport
- `kv.close()` — disconnect, revert to REST
- `kv.watch(keys, cb)` — real-time key watch (requires WebSocket)
- `kv.listen(topic, cb)` — push queue listener (requires WebSocket)

---

## Gotchas

1. `open()` required for watch/listen — throws if called without WebSocket.
2. After `close()`, all subsequent calls revert to REST.
3. `getAsync` uses local singleflight + atomic set-if-not-exists for cross-process safety.
4. WebSocket auth: post-connect message with `{ token }` or query param `?token=TOKEN`.
