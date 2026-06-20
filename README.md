<!-- docs: sync from coderbuzz/codex@8a99d5c -->

# KVS Client &mdash; `@coderbuzz/kvs-client`

> **TypeScript client SDK for `@coderbuzz/kvs-server`.** REST-first, transparently upgrades to WebSocket RPC. Watch keys in real-time, listen to queue push delivery.
> AI agents: see [AI_KNOWLEDGE.md](https://github.com/coderbuzz/kvs-client/blob/main/AI_KNOWLEDGE.md) for expert context.

KVS Client is a fetch-based TypeScript SDK for communicating with a `@coderbuzz/kvs-server` instance. After calling `open()` it transparently upgrades to WebSocket JSON-RPC for lower latency. Same API over both transports.

---

## Features

- **REST-first** — works immediately after construction, no setup
- **WebSocket RPC** — lower latency with `open()`, auto-fallback on disconnect
- **getAsync** — cache-with-compute with singleflight deduplication
- **Atomic operations** — fluent builder for multi-key transactions
- **Watch** — real-time key-change subscriptions (requires WebSocket)
- **Listen** — push-based queue delivery with work-stealing (requires WebSocket)

---

## Installation

```sh
npm install @coderbuzz/kvs @coderbuzz/kvs-server @coderbuzz/kvs-client
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

// Upgrade to WebSocket RPC
await kv.open();
await kv.set(["greeting"], "hello ws"); // now over WebSocket
kv.close();
```

---

## API

### `new KvsClient(options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `url` | `string` | required | Server base URL (e.g. `http://localhost:3000`) |
| `token` | `string` | required | Bearer access token |

### KV Methods

| Method | Signature | Description |
|---|---|---|
| `get` | `(key: KvKey): Promise<KvEntry \| null>` | Get entry by key |
| `set` | `(key, value, options?): Promise<KvCommitResult>` | Set value (optional TTL) |
| `delete` | `(key): Promise<{ ok }>` | Delete key |
| `list` | `(selector, options?): Promise<KvListResult>` | List by prefix or range |
| `atomic` | `(): AtomicBuilder` | Start atomic operation chain |

### Queue Methods

| Method | Signature | Description |
|---|---|---|
| `enqueue` | `(payload, options?): Promise<{ ok, id }>` | Enqueue message |
| `dequeue` | `(topic?, limit?): Promise<QueueMessage[]>` | Dequeue messages |
| `acknowledge` | `(id): Promise<boolean>` | Acknowledge message |

### WebSocket

| Method | Description |
|---|---|
| `open()` | Connect WebSocket, authenticate, switch to RPC |
| `close()` | Disconnect, revert to REST |
| `watch(keys, callback)` | Subscribe to key changes (requires WebSocket) |
| `listen(topic, callback)` | Push-based queue delivery (requires WebSocket) |

### Utilities

| Method | Signature | Description |
|---|---|---|
| `health()` | `(): Promise<{ ok, uptime }>` | Server health check (no auth) |
| `reset()` | `(): Promise<{ ok }>` | Delete all data (testing only) |
| `cleanExpired()` | `(): Promise<{ ok, deleted }>` | Manually expire stale KV entries |
| `getAsync` | `(key, fn, ttl?): Promise<T>` | Cache-with-compute, singleflight |

---

## Transport

| Feature | REST | WebSocket RPC |
|---|---|---|
| Default | Yes | No (requires `open()`) |
| Latency | Request-response | Lower (persistent connection) |
| Watch | — | Yes |
| Listen | — | Yes |
| Auto-reconnect | — | Manual (`close()` reverts to REST) |

---

## License

MIT &copy; 2026 Indra Gunawan
