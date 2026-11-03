# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project intends to
use [Semantic Versioning](https://semver.org/) once a public release exists;
no release version has been assigned yet.

## [Unreleased]

### Fixed

- A new viewport capture removes superseded references for that page, so moving
  through conversations cannot exhaust the visual cache with unusable refs.
  Stopping control also drains a just-settled debugger attachment instead of
  leaving it connected. The visual smoke checks worker-restart cleanup, rejected
  old coordinates and a fresh capture after explicit binding. Sharing settings
  now name screenshots alongside page text.
- Normal Host shutdown uses a retryable close instead of reporting a permanent
  client replacement. With an open panel, the extension can reconnect using its
  saved credential after the Host returns. Actual replacement, invalid credentials
  and compatibility failures still stop automatic reconnection. Transport
  reconnection does not restore task execution or replay browser actions.
- Losing a managed task's page control or native binding now pauses its exact
  control revision and cancels its Agent while keeping the confirmed browser
  connection. Background-owned revocation also fences a pin lost before startup
  commits; stale pins cannot interrupt a fresh handoff. The optional wire-v4
  capability is negotiated by both peers, and older panels receive generic
  paused metadata. Unconfirmed notifications close only their original owner.
- Connection loss during a paused task's handoff also fences the reserved future
  revision before `running` is saved. No model activity may start in that gap.
- Tasks whose cumulative time, model-request or browser-call limit is already
  exhausted cannot start or resume, including native page handoff. The Host
  refuses activation before attaching a target, and the panel keeps stop
  available with guidance to create a new task. Older compatible Host summaries
  cannot restore exhausted controls. The last admitted activity can still
  complete trusted verification; continuation never resets its counters.
- DSH user cancellation is scoped to its original task control revision and
  cannot stop a later explicit continuation. Cancellation during independent
  verification or final outcome persistence is acknowledged after that work
  exits; already committed evidence is retained without completing the task.
- Continued tasks start with a pending outcome while retaining their fixed goal,
  cumulative counters and committed evidence. A verifier draining from an older
  control revision cannot replace a paused, stopped or newly running outcome.
  Its elapsed verification time is still counted. Regression checks cover
  continuation both before evidence returns and after an earlier fact commits.
- Native selected-page start/continuation releases its unused prepared pin when
  the Host explicitly confirms a rejection before target attachment. A later
  trusted click can prepare a fresh pin. Lost replies, legacy errors and any
  attachment/commit uncertainty retain the original pin without automatic retry;
  duplicate committed pins can never be reported safe to release.
- Model and browser-tool admissions recheck their job after counter persistence.
  A disconnect or pause during that write cannot return permission to enter the
  provider or tool afterwards; counters remain monotonic.
- Losing or replacing a browser connection immediately fences explicit tasks
  owned by its native target and cancels their active Agent scope before the
  durable pause is queued. The panel records a connection-loss pause reason;
  reconnecting never resumes the task. Explicit selected-page continuation uses
  a fresh revision, while pending, unresolved and failed writes still block it.
  Old connection events cannot pause a successor revision. Host restart recovery
  and automatic write reconciliation remain unavailable.
- **Save and connect** can reconnect a stopped bridge without changing its
  address or credential. Policy-only saves and keepalive still cannot reclaim
  a connection that another client replaced.
- Accepted native task-page grants no longer depend on their original startup
  connection, panel or session binding. Preparation remains fenced; later page
  calls require fresh task/connection authority, and native stop or opt-in
  revocation still withdraws page access.
- Browser model guidance aligns direct new-page opening with the tool contract,
  explains returning observations from `run_code`, and distinguishes requested
  page confirmation from independent persistence proof. It discourages repeated
  writes and shell/network substitution. Benchmark suite 5 records this prompt change.
- Ordinary-chat model acceptance checks the blue DSH control group, its window
  and the sole new-page grant, and records finalized tool outcomes. Its scope and
  request limits have regression checks; CI also builds the Firefox extension.
- Model-facing tools make direct URL opening explicit. Listing an empty admitted
  page scope returns an empty result without native tab reads or an approval;
  it cannot acquire pages authorized after the request arrived.
- Failed new-tab adoption releases its own page grant independently of browser
  tab removal, including metadata failures, cancellation and expired admission.
  Cleanup cannot revoke a newer user grant or close a page after user takeover.
  A failed native close is reported as unconfirmed rather than successful.
- Automatic debugger attachment waits for the newly created HTTP(S) tab during
  navigation. Startup connection rejection is retried only while navigation is
  pending; completed-page refusals, policy errors and cancellation remain final.
  Page actions are never replayed by this connection preparation.

- Debugger page operations recheck their original request immediately before
  delivery and commit writes only there, so cancellation or retargeting during
  controller preparation cannot dispatch an old action. Evaluations use unique
  browser context identities across process changes. Cached manual page grants
  require a native scripting probe during recovery; visible tab metadata is not
  sufficient evidence of page access.

- Page revocation commits a private epoch before updating its session cache, so
  a failed cache write cannot restore old grants after a worker restart. Recovery
  rechecks native tab/window/origin/group identity and processes startup events.
  Tab-management requests retain their original grants across waits and cannot
  acquire a later authorization. Authorized pages expose Stop control even before
  binding a task. Native pinning is preserved; Chrome control now requires an
  unpinned page. Firefox loopback navigation requires a fresh grant just like
  navigation on other sites.

- Settled browser requests clear their original approval wait even after timeout,
  cancellation or disconnect, so subsequent task time is counted. Reaching the
  active-time limit during independent verification reports budget exhaustion.
- Revoked task execution contexts cancel their owned Agent activity immediately.
  Expired contexts cannot admit another model request while awaiting task settlement.

- Session checkpoints recheck the connection owner and a fresh document/binding
  generation after native reads. A late read cannot overwrite a newer checkpoint,
  including after same-tab rebinding, same-URL navigation or reconnect.
- Deferred tab-follow/open binding callbacks cannot acquire a replacement
  connection's authority. An undelivered page action stops recovery when its
  original connection or target has been revoked.

### Added

- Optional Chrome viewport images and screenshot-bound synthetic points for canvas
  and image-based pages. Screenshots use native tab identity and Host image
  attachments, including PTC delivery; base64 bytes are not model text. Points
  retain group authorization, page-sharing/action approval, original document,
  session/connection and managed revision fences. References are single-use and
  invalidated by observed page/viewport changes. Visual debugger connections keep
  manual origin limits, revoke with their owner and clean up after worker loss.
  Controlled canvas checks cover attachment pixels, layer inspector readback,
  scroll/zoom, conversation isolation and native revocation; real-model checks
  remain explicit and bounded. Native input, Firefox/desktop vision and hidden
  design metadata extraction are not provided.

- Chrome queued tasks offer native **Open a new page and start** with a typed
  HTTP(S) URL and the saved automatic-control opt-in. Connection-owned, single-use
  Host tickets reserve startup before creation; the worker authorizes, groups and
  pins the page before the Agent starts. Confirmed pre-start failures clean only
  their owned page, while lost startup replies preserve it without automatic retry.
  Managed model tab mutations remain unavailable; optional metadata keeps wire v4
  compatibility. `STRIDE_TASK_NEW_PAGE=1` extends the isolated real-model task check.
- An opt-in real-model ordinary-chat acceptance script verifies new-tab creation,
  conversation binding, the control group and independently saved synthetic-site
  state, using temporary Host/browser homes and the configured default model.
- Chrome settings offer opt-in automatic control of DSH-created tabs using
  `debugger` and tab-metadata permissions. New tabs bind to the originating ordinary
  conversation and join the control group without another toolbar click. Only the
  main HTTP(S) document is supported; existing tabs retain separate authorization.
  Stops, settings revocation and debugger disconnection withdraw authority; grants
  are not restored across worker/browser restarts. Firefox retains the selected-page
  flow. Browser capabilities are broader than the application
  allowlist; page sharing and action confirmation settings still apply.
- Manual page access uses a native toolbar click and temporary `activeTab` permission.
  Only local DSH communication retains a declared loopback host permission. Authorized tabs
  appear in the blue **DSH 控制** group, separately in each window. Dragging a tab
  into a group grants no access; leaving it or choosing **Stop controlling this
  page** revokes Stride control. Cross-origin navigation and browser restarts
  require another toolbar click. Action-confirmation bypass stays inside authorized
  tabs. Without the Chrome automatic-control opt-in, model-created tabs remain
  unbound until the user authorizes them.
- Observation identifiers also work on plain HTTP pages where `randomUUID` is
  unavailable, using cryptographic `getRandomValues` without a weak fallback.

- Extension settings provide **Unpair DSH**: stop reconnecting, remove the local
  credential and, when reachable, revoke that installation on the Host. The
  disconnected state survives browser restarts and requires explicit pairing to
  reconnect. Offline unpairing reports that Host revocation is unconfirmed.
  Open pages and conversations are preserved; there is no page-unbinding button.

- DSH Web's explicit `/browser <goal>` command creates a waiting task without
  waking its Agent. The extension's trusted **Bind and start** action reserves
  a native target before execution. Queued task sessions remain selectable.
  The Host drives the existing Agent in a run scope, counts model admissions
  and browser subcalls, and cancels owned model activity on pause/stop. Initial
  cumulative limits exclude human waits. PTC callbacks require a live original
  Host parent token. Trusted Host verifiers supply independent completion facts;
  missing evidence and uncertain writes remain unverified without automatic replay.
  Controlled-form and opt-in real-model checks are test fixtures; there is no
  task-specific form business logic in the product runtime.

- Eligible paused runs can continue on the page explicitly bound by the user.
  A trusted panel click checks the displayed binding revision; the worker reserves
  an opaque native target and the Host registers it before publishing the new
  running revision. Pending, unresolved or failed writes and recovery-required
  records block handoff. Old execution contexts remain revoked, and the executor
  must enter a fresh context. The selected document is fenced until the first
  execution confirmation. The optional `canRetarget` capability keeps wire v4
  compatibility; uncertain replies are refreshed without automatic retries.

- Wire protocol v4 pins managed page operations to the first confirmed native
  tab/binding for a run/control revision. Known pins enter command digests;
  rebinds, tab lifetime/window changes and connection replacement cannot renew
  them. A fresh trusted revision can select a new target. Managed open/follow/close
  tools remain refused; unscoped tools retain
  their existing permission paths. Account/tenant identification is not implemented.

- The v3 confirmation flow (extended by v4) requires explicit legacy/run scopes, includes run/control
  metadata in command digests and confirms original pending requests before
  browser dispatch. Confirmation is single-use and connection-owned; copied ids,
  expired contexts and late replies cannot create or renew execution. Browser
  approvals still apply. Historical v2 ledger rows remain readable without replay.

- Received page calls pin their browser target before receipt/approval/queue
  waits. Navigation, history changes, rebinding, tab lifecycle changes and new
  connections fence old pending work. Expired reads are withheld, and cancelled
  waiters cannot release later writes before a dispatched action settles. These
  worker-local fences do not establish full run/account/tenant authority.

- The side panel displays bounded metadata for existing Host-owned browser runs,
  with version-checked pause/stop controls and explicit stopping acknowledgement.
  Synthetic clicks, foreign-session controls and queued controls from replaced
  connections are refused. Creation and facts stay Host-only; automatic
  reconciliation remains unimplemented.

- Trusted Host `withExecution` contexts bind real browser dispatch to a run and
  control revision. Controls and storage faults revoke old contexts; detached
  work and unscoped managed-session calls fail closed. Dispatch records retain
  the run/revision without treating transport receipts as business evidence.
  Pending or uncertain writes fence new execution; unfinished runs block session purge.
  Account/tenant identification and task orchestration remain unimplemented.

- Owner-confirmed browser pairing: the extension requests a short-lived matching
  verification code, an authenticated DSH settings user approves, and only the
  requesting extension may claim its installation credential. Requests are
  bounded, expire after five minutes, and are discarded on Host restart. Existing
  manual codes and saved-credential reconnect remain supported. Revocation also
  cancels outstanding requests for the installation.

- The initial v2 action fence (superseded by v3) introduced Host-issued logical action ids and SHA-256 command
  digests on calls and replies. The Host ignores replies with mismatched ids or
  digests, and the extension verifies the command before execution admission.
- Extension-origin IndexedDB commits an execution fence before dispatch and a
  finish marker after settlement. Repeated ids and conflicting commands are
  refused across worker restart, without caching page/input text or replaying
  results. Corrupt receipts and unavailable/full storage fail closed; 5,000 fences are
  retained with no automatic eviction.
- Real browser tool calls persist request identities/digests before dispatch
  and transport receipt metadata before returning results. Cancellation,
  timeout and connection loss retain uncertainty; late same-connection replies
  can update the record without replaying the action or reviving the caller.
- Dispatch metadata omits raw arguments, result text and peer error messages.
  Permanent session deletion also removes its settled dispatch records and
  refuses deletion while a recorded dispatch is still active.
- A Host-only `browserRuns` service uses DSH storage domains for durable run
  state, version-checked controls and immutable action facts. Reopening fences
  unfinished execution contexts and refuses automatic resume. Browser tools
  use explicit Host scopes; the panel reads metadata and controls existing runs.
  Task creation and action facts remain Host-only; the panel now also supports
  explicit selected-page continuation for eligible paused runs.
- The Host rejects unversioned and incompatible extension handshakes before
  authentication, preserving its current connection and unconsumed pairing code.
- The extension rejects incompatible Host handshakes before accepting a new
  credential or dispatching tools, with localized upgrade guidance and no
  automatic reconnect loop.
- Snapshot limits are bounded by both peers' handshake offers; the extension
  rejects an acknowledgement that exceeds its offer.
- Execution contract skeleton in
  `packages/browser/bridge-browser/src/contracts/`: identity layers,
  observation envelopes, action facts, run lifecycle, error taxonomy and
  capability negotiation. Observation helpers are used by the extension and
  lifecycle/fact rules by the Host record service; a complete task executor
  is not implemented.
- `pnpm run stride:baseline` collector with a fixed upstream reference; local
  machine evidence is kept out of the public working tree.
- Local one-time installation pairing, separately revocable credentials, and
  extension-origin credential storage.
- Bounded in-memory ordering and cancellation for browser writes, plus
  single-select and basic form-state readback.
- Observation-bound references for click, type and select; stale, unrendered,
  cross-frame and truncated-option references are rejected. Resolved link and
  form submission targets are checked before activation.
- Invalidate pending and saved observations on document, History API and
  fragment navigation events, including same-URL history transitions.
- Recheck delayed link activation at execution time and report its outcome as
  unconfirmed until the page is observed again.
- Avoid issuing a second navigation after a browser-dispatched link click.
- Recheck text and select targets between synchronous page events, report
  possible partial changes, and refuse typing into read-only or non-text inputs.
- Text observations identify their delta baseline, text scope and collection
  limits; missing selectors and unusably small snapshot budgets fail explicitly.
- Form snapshots and shared action deltas expose native constraint status and
  observed ARIA-invalid changes without triggering validation events or copying
  custom validation messages. They do not establish that a site saved data.
- Recognizable one-time-code and payment fields are masked in form snapshots,
  extracted page text and selections, with bounded fail-closed text redaction.
  This is heuristic and does not identify every unmarked custom control.
- Optional shared model guidance asks for business-result checks and cautions
  against retrying writes with unknown outcomes; it is not runtime enforcement.
- An opt-in isolated browser smoke exercises the real DSH tool runtime and
  extension against a synthetic site with independently checked saved state.
- Open-source governance: `SECURITY.md`, `CONTRIBUTING.md`, issue forms,
  and `CHANGELOG.md`.

### Changed

- Chrome controls only authorized members of its DSH control group. Human tab
  switches no longer pause tools, retarget tasks or prompt for a keep/follow
  choice. The side panel selects from authorized group pages; initial task
  startup uses that selection even while the user browses elsewhere. Pinned
  pages must be unpinned first, and failed grouping grants no control. Native
  page loss and group exit still revoke authority and pause the exact task.

- The workspace is named `dsh-browser-stride`; upstream provenance and the
  source directory layout are preserved.
- The Host component is now `@eilyeee/dsh-browser-stride`. Workspace
  imports, the Host settings module and installers use this name. Installers
  migrate transitional and legacy package registrations after installing the new package;
  pairing namespaces, run domains and extension identity remain unchanged.
- Both READMEs carry a product-branch notice and an unofficial-project
  disclaimer; the README i18n record is refreshed.
- CI also runs on pushes to `stride/main`, not only `main`.
- Dependencies and the Node/pnpm toolchain are pinned; the bridge is adapted
  to the DSH 0.2.1 release-candidate Host API.
- Align the DSH Host and client peers on `0.2.1-rc.5` and allow the bridge
  settings client to run with React 19.
- Keep Node declarations on the Node 24 baseline and group React runtime and
  declaration updates together in Dependabot.
- Security overrides for vulnerable versions pinned by DSH, with focused MCP
  and archive compatibility checks and a clean npm advisory audit.
- DOM settle timeouts now report an unquiet page and invalidate prior
  references. The benchmark tool interface changed; its suite version is 4 and
  must not be aggregated with older results.
- The benchmark connects the extension using a one-time pairing code, binds
  each session to its target tab, redacts Host launch credentials in logs, and
  owns the actual DSH process so it can shut down cleanly.
- The benchmark detects current Intel macOS Chromium cache layouts, including
  the full browser required for extension tests.
- The key tool sends synthetic keyboard events without fabricating a form
  submit; native key behavior and effects of page handlers remain unconfirmed.
- Bare-index clients are incompatible with the current element actions; update
  Bridge and extension together.
- Baseline collection distinguishes original upstream provenance from the
  rewritten publication ancestor when counting commits (evidence schema v2).

### Removed

- Generated `packages/browser/bridge-browser/coverage/` artifacts that were
  committed upstream. They were build output and contained a maintainer's
  absolute local path. `coverage/` is now ignored.
- Local machine baseline evidence and an inherited funding link from the current
  tree; publication still requires a fresh review before pushing.
- Machine-specific coverage artifacts, local baseline evidence and private
  downstream email addresses from the rewritten publication history. Original
  upstream references and a private local backup remain outside that branch.
- The inherited upstream update checker and remote installer handoff, which
  could offer to replace a Stride installation with upstream code.
