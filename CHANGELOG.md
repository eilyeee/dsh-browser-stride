# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project intends to
use [Semantic Versioning](https://semver.org/) once a public release exists;
no release version has been assigned yet.

## [Unreleased]

### Changed

- The Host component is now `@eilyeee/dsh-stride-browser-bridge`. Workspace
  imports, the Host settings module and installers use this name. Installers
  migrate both legacy package registrations after installing the new package;
  pairing namespaces, run domains and extension identity remain unchanged.

### Added

- The side panel displays bounded metadata for existing Host-owned browser runs,
  with version-checked pause/stop controls and explicit stopping acknowledgement.
  Synthetic clicks, foreign-session controls and queued controls from replaced
  connections are refused. Creation, resume and facts stay Host-only; automatic
  reconciliation remains unimplemented.

- Trusted Host `withExecution` contexts bind real browser dispatch to a run and
  control revision. Controls and storage faults revoke old contexts; detached
  work and unscoped managed-session calls fail closed. Dispatch records retain
  the run/revision without treating transport receipts as business evidence.
  Pending or uncertain writes fence new execution; unfinished runs block session purge.
  Receiver run/target authority and task orchestration remain unimplemented.

- Owner-confirmed browser pairing: the extension requests a short-lived matching
  verification code, an authenticated DSH settings user approves, and only the
  requesting extension may claim its installation credential. Requests are
  bounded, expire after five minutes, and are discarded on Host restart. Existing
  manual codes and saved-credential reconnect remain supported. Revocation also
  cancels outstanding requests for the installation.

- Wire protocol v2 carries Host-issued logical action ids and SHA-256 command
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
  Task creation, resume and action facts remain Host-only.
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
  and dispatch ledger are not implemented.
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

- The workspace is named `dsh-browser-stride`; upstream package names and
  published versions are unchanged.
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
