# Browser bridge

English | [中文](README.zh.md)

The bridge mounts a loopback-only, token-authenticated WebSocket on the local DeepSeek Harness Host and registers text-based `browser_*` tools. The browser extension performs the actual page operations. See the [repository README](../../../README.md) for setup and current limitations.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `token` | generated | Administrator token for pairing; if unset, the Host stores it in `DSH_HOME/ext-bridge-token` with restricted permissions. It is not a browser credential and is not logged. |
| `allowHostManagement` | `false` | Separate Host-side opt-in for settings, credentials and local-path gateway methods. A browser connection alone does not grant these permissions. |
| `pairingProfile` | `web` | Namespace for persisted installation credentials under `DSH_HOME/browser-bridge-pairings`. Only one Host process may own a namespace at a time. |
| `toolTimeoutMs` | `90000` | Per-tool timeout in milliseconds. |
| `snapshotMaxChars` | `32000` | Snapshot character limit; minimum 500. |
| `maxInteractiveItems` | `60` | Maximum interactive items per snapshot. |
| `sessionWorkspacePath` | `DSH_HOME/browser-sessions` | Workspace for extension-created sessions; an empty string disables grouping. |
| `deferSessionCreate` | `true` | Materialize a new session when the first prompt is sent. |

`/ext/bridge-config` exposes only the local WebSocket address. Pairing administration is loopback-only, requires the separate administrator token and rejects browser Origin headers. A one-time code expires after five minutes; only a hash of the resulting installation credential is persisted by the Host. See the root README for issue/list/revoke commands. Extension credentials use extension-origin IndexedDB, including on Firefox where `storage.local` access cannot be restricted.

The shared [wire protocol](src/protocol.ts) is distinct from the [execution contract types](src/contracts/). The latter are not yet connected to a durable task runtime. Use the workspace checks in the root README and test real-browser behavior separately.
