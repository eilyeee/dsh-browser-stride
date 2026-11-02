# DSH Stride Browser Bridge

English | [中文](README.zh.md)

`@eilyeee/dsh-browser-stride`
The bridge mounts a loopback-only, token-authenticated WebSocket on the local DeepSeek Harness Host and registers text-based `browser_*` tools. The browser extension performs the actual page operations. See the [repository README](../../../README.md) for setup and current limitations.

## Configuration

For first connection, click **Connect to local DSH** in extension settings, then confirm the matching code in the signed-in DSH **Settings → General → Browser pairing** section. Up to eight requests stay in memory for five minutes; only a Connection-authenticated owner can approve them. Request proofs and installation credentials never enter Host pages or URLs. Credentials can be claimed once; lost responses, restart or storage failure require a fresh confirmation. Manual pairing codes remain supported. Normal source upgrades preserve pairing when the original extension installation and Host data remain; see the repository README for update steps.

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

The shared [wire protocol](src/protocol.ts) is distinct from the [execution contract types](src/contracts/). The Host provides `ctx.browserRuns` for trusted plugins: queued run creation, version-checked state changes, pause/resume/stop, immutable action facts, and completion checks against declared criteria. Facts must be supplied by trusted Host code; tool success text is not verified evidence. Browser tools use its child dispatch ledger and explicit Host execution contexts. The panel reads metadata and controls existing runs, including selected-page continuation for eligible paused runs; creation and fact records remain Host-only.

Trusted Host code awaits browser work inside `withExecution(runId, controlRevision, async () => { /* await browser tools */ })`. The Bridge obtains the run, session and control revision from this async context, never from model arguments. Sessions with active or unreconciled runs cannot fall back to unscoped dispatch; unattributed calls cannot bypass an active run. Independent legacy sessions retain their existing behavior.

Pause, stop, resume, blocking, uncertain facts, storage faults and closure revoke old contexts. Resume requires a new context at the current revision. Old callbacks and detached children do not inherit fresh authority. Before browser dispatch, the extension uses `bridge.tool.confirm` to match the original pending request, action digest, session and run/control scope. The Host revalidates its captured execution object independently of the RPC async chain; copying ids cannot create a context. Confirmation is single-use and connection-owned. Cancellation revokes pending grants, including while approval is waiting; already dispatched effects remain uncertain. Account/tenant identification, task creation/orchestration, business verification and automatic recovery remain unavailable.

The first confirmed managed page call pins an opaque extension-owned tab/binding id for its run/control revision. Later calls carry that expected id in the command digest and must match the same live native binding. A same-tab navigation can continue, while rebinding, tab lifetime/window changes and connection replacement fence the old pin. The Host keeps the connection owner across socket replacement; the worker refuses to reconstruct a missing expected id after restart. Selected-page continuation reserves a fresh target before the new running revision is published. That document must stay current until its first successful execution confirmation, after which normal same-tab navigation is supported. Both caches are process-local and bounded to 5,000 entries, with no automatic eviction. This is tab binding, not account/tenant identification. Managed open/follow/close tools remain refused before dispatch recording; only explicit user page binding and continuation can hand off a paused run.

Pending writes block starting, resuming or entering a new execution scope. Unresolved writes and failed write receipts also block further dispatch: failure can occur after a partial effect. A late successful receipt settles transport uncertainty without reviving old contexts or proving business success. There is no automatic reconciliation path yet.

The service requires DSH `storageDomain`, using domain `browser_runs_<UTF-8 hex of pairingProfile>` and the configured storage backend. The default JSON backend writes private files atomically; it does not coordinate multiple Host processes sharing one storage root. On reopen, unfinished execution contexts are fenced by a new control revision, running records become blocked, and stopping records remain stopping. Such records cannot resume until recovery support is implemented; no browser action is replayed. Raw run/fact RPCs and side-panel run deletion remain unavailable. Use the workspace checks in the root README and test real-browser behavior separately.

A storage-write failure disables subsequent writes until the domain is reopened. Unreconciled effects also block another run from starting in the same session. Each run accepts up to 128 distinct required criteria and 256 immutable facts. Stored state is a record, not permission to dispatch browser actions.

## Panel task controls

The authenticated browser connection handles `bridge.browserRuns.list` with `{ sessionId }` and `bridge.browserRuns.control` with `{ sessionId, runId, expectedVersion, control }`. Only `pause` and `stop` are accepted. The Host checks session ownership and the record version, and queued controls are cancelled with their original connection. These methods do not create tasks, grant browser permissions, record facts or resume work.

An optional `canRetarget` summary field enables **Continue on selected page** for paused runs without recovery requirements or pending, unresolved or failed writes. The user first binds the intended page above the conversation, then clicks the button. The worker checks the displayed binding revision and native target, generates an opaque pin, and calls `bridge.browserRuns.retarget` with `{ sessionId, runId, expectedVersion, controlRevision, targetBinding }`. Generic panel RPC forwarding cannot call this method. The Host checks ownership and versions and reserves the connection-owned pin before persisting `running`, advancing the control revision twice for `target_changed` and `resume`. Old contexts stay revoked; trusted Host code must enter a fresh `withExecution` context to continue. This does not start an executor or resume an ordinary chat automatically. An uncertain result only triggers a status refresh. The wire protocol remains v4; older compatible Hosts omit the capability and older panels ignore it.

The panel refreshes metadata every two seconds while open and connected. Responses contain at most 20 runs, unfinished first, with a total count; they omit criteria, facts, page evidence and arguments. A version conflict or uncertain reply triggers a state refresh, never an automatic command retry. `stopping` means the executor has not confirmed stopping yet. Ordinary chat sessions have no task card until trusted Host code creates a run. The normal chat cancel button still controls the Agent separately.

## Dispatch records

`ctx.browserRuns.dispatches` records every production `browser_*` dispatch, including calls without an Agent session. It uses a separate `browser_dispatches_<UTF-8 hex of pairingProfile>` domain. The Host commits request metadata and a digest before sending, then commits receipt metadata before returning the tool result. Cancellation, expiry and connection ownership are rechecked after each pre-dispatch write.

| State | Meaning |
| --- | --- |
| `prepared` | Request recorded; no dispatch marker committed. |
| `sent_unconfirmed` | Marker committed before socket send; actual delivery is unconfirmed. |
| `not_sent` | Host did not send, or restart found only a prepared record. |
| `unresolved` | Delivery or result is unknown after timeout, cancellation, disconnect or restart. |
| `returned` | Extension reply metadata recorded; this does not verify a business result. |

Records contain Host action/request/connection ids, optional installation/session ids and paired run/control-revision metadata, tool name, read/write classification, a SHA-256 request digest, timestamps and fixed status/error codes. Raw arguments, input values, page results and peer error messages are omitted. Read/write classification is shared with the extension; unknown tools count as writes. A storage failure stops subsequent ledger writes and dispatches until reopen. A late reply on the same connection can update an unresolved record while preserving its interruption; it does not revive the old caller. No action is automatically retried or replayed.

Permanent session purge removes its settled dispatch records after session storage deletion; unfinished runs and active dispatches block that operation. Unscoped records have no automatic expiry. Task-state/fact records retain their separate lifecycle.

Wire protocol v4 carries `{ actionId, requestDigest }` and an explicit execution scope. New ledger rows use `identityVersion: 4`: the command digest binds action id, tool name, arguments, optional session id and legacy/run scope, including run id/control revision and any previously confirmed target binding. `transportDigest` separately binds the original transport metadata. Confirmation cannot be reused after cancellation, context exit or connection replacement. Historical v2/v3 and transport-only rows remain readable audit data and are never upgraded into replayable requests. Build and reload both components together; older binaries may reject v4 ledger rows.

The extension commits an IndexedDB execution fence before entering the existing approval/target/write-queue flow. Repeated ids are refused, including after worker restart; changed command digests are conflicts. Only identity, timestamps and admission/finish phase are retained. A finish marker does not establish delivery or business success, and no stored page result is returned for a duplicate. The 5,000-record store has no automatic eviction, so a full or unavailable store refuses new execution, and a corrupt matching fence refuses its action. Host session deletion does not remove these replay fences. Account/tenant identification and automatic reconciliation remain unimplemented; execution confirmation does not bypass browser permissions.
