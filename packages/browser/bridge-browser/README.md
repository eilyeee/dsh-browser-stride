# Browser bridge

English | [中文](README.zh.md)

The bridge mounts a loopback-only, token-authenticated WebSocket on the local DeepSeek Harness Host and registers text-based `browser_*` tools. The browser extension performs the actual page operations. See the [repository README](../../../README.md) for setup and current limitations.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `token` | generated | Administrator token for pairing; if unset, the Host stores it in `DSH_HOME/ext-bridge-token` with restricted permissions. It is not a browser credential and is not logged. |
| `allowHostManagement` | `false` | Separate Host-side opt-in for settings, credentials and local-path gateway methods. A browser connection alone does not grant these permissions. |
| `pairingProfile` | `web` | Namespace for installation credentials under `DSH_HOME/browser-bridge-pairings` and the browser-run storage domain. Only one Host process may own a storage root/namespace at a time. |
| `toolTimeoutMs` | `90000` | Per-tool timeout in milliseconds. |
| `snapshotMaxChars` | `32000` | Snapshot character limit; minimum 500. |
| `maxInteractiveItems` | `60` | Maximum interactive items per snapshot. |
| `sessionWorkspacePath` | `DSH_HOME/browser-sessions` | Workspace for extension-created sessions; an empty string disables grouping. |
| `deferSessionCreate` | `true` | Materialize a new session when the first prompt is sent. |

`/ext/bridge-config` exposes only the local WebSocket address. Pairing administration is loopback-only, requires the separate administrator token and rejects browser Origin headers. A one-time code expires after five minutes; only a hash of the resulting installation credential is persisted by the Host. See the root README for issue/list/revoke commands. Extension credentials use extension-origin IndexedDB, including on Firefox where `storage.local` access cannot be restricted.

The shared [wire protocol](src/protocol.ts) is distinct from the [execution contract types](src/contracts/). The Host provides `ctx.browserRuns` for trusted plugins: queued run creation, version-checked state changes, pause/resume/stop, immutable action facts, and completion checks against declared criteria. Facts must be supplied by trusted Host code; tool success text is not verified evidence. Browser tools use its child dispatch ledger; task lifecycle/fact records are not yet connected to the tools or side panel.

The service requires DSH `storageDomain`, using domain `browser_runs_<UTF-8 hex of pairingProfile>` and the configured storage backend. The default JSON backend writes private files atomically; it does not coordinate multiple Host processes sharing one storage root. On reopen, unfinished execution contexts are fenced by a new control revision, running records become blocked, and stopping records remain stopping. Such records cannot resume until recovery support is implemented; no browser action is replayed. There is no run-record RPC or side-panel deletion control yet. Use the workspace checks in the root README and test real-browser behavior separately.

A storage-write failure disables subsequent writes until the domain is reopened. Unreconciled effects also block another run from starting in the same session. Each run accepts up to 128 distinct required criteria and 256 immutable facts. Stored state is a record, not permission to dispatch browser actions.

## Dispatch records

`ctx.browserRuns.dispatches` records every production `browser_*` dispatch, including calls without an Agent session. It uses a separate `browser_dispatches_<UTF-8 hex of pairingProfile>` domain. The Host commits request metadata and a digest before sending, then commits receipt metadata before returning the tool result. Cancellation, expiry and connection ownership are rechecked after each pre-dispatch write.

| State | Meaning |
| --- | --- |
| `prepared` | Request recorded; no dispatch marker committed. |
| `sent_unconfirmed` | Marker committed before socket send; actual delivery is unconfirmed. |
| `not_sent` | Host did not send, or restart found only a prepared record. |
| `unresolved` | Delivery or result is unknown after timeout, cancellation, disconnect or restart. |
| `returned` | Extension reply metadata recorded; this does not verify a business result. |

Records contain Host action/request/connection ids, optional installation/session ids, tool name, read/write classification, a SHA-256 request digest, timestamps and fixed status/error codes. Raw arguments, input values, page results and peer error messages are omitted. Read/write classification is shared with the extension; unknown tools count as writes. A storage failure stops subsequent ledger writes and dispatches until reopen. A late reply on the same connection can update an unresolved record while preserving its interruption; it does not revive the old caller. No action is automatically retried or replayed.

Permanent session purge removes its settled dispatch records after session storage deletion; active dispatches block that operation. Unscoped records have no automatic expiry. Task-state/fact records retain their separate lifecycle.

Wire protocol v2 carries `{ actionId, requestDigest }` on calls and replies. New ledger rows use `identityVersion: 2`: the command digest binds action id, tool name, arguments and optional session id; `transportDigest` separately binds the original request/connection/installation/deadline material. The Host requires both action identity fields to match before accepting a reply. Historical rows without the new identity remain readable as audit data and are never upgraded into replayable requests. Build and reload both components together; an older binary may reject the newer ledger fields.

The extension commits an IndexedDB execution fence before entering the existing approval/target/write-queue flow. Repeated ids are refused, including after worker restart; changed command digests are conflicts. Only identity, timestamps and admission/finish phase are retained. A finish marker does not establish delivery or business success, and no stored page result is returned for a duplicate. The 5,000-record store has no automatic eviction, so a full or unavailable store refuses new execution, and a corrupt matching fence refuses its action. Host session deletion does not remove these replay fences. Full run/control-revision/live-target binding and automatic reconciliation remain unimplemented; action identities grant no browser permission.
