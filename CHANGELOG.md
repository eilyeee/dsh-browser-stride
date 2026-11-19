# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project intends to
use [Semantic Versioning](https://semver.org/) once a public release exists;
package versions currently identify development builds, not supported releases.

## [Unreleased]

### Added

- Trusted Host integrations can independently recheck an account, tenant and
  record scope before dispatching a managed write. A failed scope check stops
  the task for review with the action recorded as unsent.

- Trusted readback integrations can supply an explicit-offset ISO 8601
  timestamp as their pre-action version. The verifier compares instants at
  millisecond precision and requires a strictly newer value of the same type.
- Trusted readback checks can verify signed 64-bit record IDs against their
  exact decimal representation in the original backend JSON.

- Development build 0.1.35 shows the version reported by the connected
  extension in DSH's browser pairing settings. Older extensions still
  connect on wire v4 and appear as connected with the version unavailable.

- Development build 0.1.28 adds operation time, bounded operation type and
  uncertainty reason to native review lists, without storing input values or
  deciding whether an action took effect. Changes to this context invalidate
  the review offer. Older peers still parse the existing label field.
- Trusted Host integrations can use `createReadbackVerifier` to require a fresh
  independent backend read, the captured account/record scope, a newer record
  version and exact postconditions. Evidence contains private artifact references
  and a digest. This helper does not install a verifier for arbitrary sites.
- Native page input now fences writes in affected ordinary conversations as
  well as managed tasks. A fresh snapshot or model tab switch cannot acknowledge
  takeover. Explicit native page selection/continuation is required; the deny
  fence persists across worker restart without restoring acknowledgements.

- Development build 0.1.27 reports a bounded, worker-local last native
  selection outcome for the calling conversation. It returns only a state
  and fixed failure code, expires after five minutes, and grants no authority.

- Development build 0.1.26 adds bounded own-conversation routing flags to
  authorized tab lists: whether a panel registered that conversation, and
  whether its target is selected and authorized. No conversation IDs or
  metadata about unauthorized pages are returned. These flags grant no
  authority and do not restore a target. Benchmark suite 35 records the output.

- Development build 0.1.23 snapshots explicitly report native form-field
  disabled, direct-edit readonly and native-required flags. Bounded numeric
  HTML/ARIA declarations distinguish absent, unusable and sensitive metadata;
  they do not prove framework/server validation or grant action permission.
- Declaration-only changes participate in snapshot deltas. Existing render
  budgets, clipped-reference admission and unknown-write fences remain in place.
  Benchmark suite 32 separates the richer snapshot text.

### Fixed

- The sidebar waits for the background to confirm its displayed conversation
  before submitting a new prompt or selecting a page. A lost registration reply
  leaves the prompt available to retry and does not replay a page action.

- Native group-page selection waits for session storage before acknowledging
  the selection. The panel distinguishes pending and unconfirmed selections,
  and a changed conversation or page can't receive a late success reply.

- Development build 0.1.36 waits for the browser to finish the new page's
  load before attaching Chrome's debugger. Setup has a deadline and late
  attachments retain their tab slot until cleanup. The readiness check uses
  Chrome's load state and frame identity. The page controller runs when an
  observation or action needs it.

- Development build 0.1.34 bounds Chrome frame discovery and page readiness
  reads. A confirmed open or navigation can report success when its optional
  snapshot takes more than 2.5 seconds. Expiry of a diagnostic start can retire
  its exclusive debugger attachment after Chrome confirms detach. A new
  explicit start remains necessary, and shared attachments retain their owner.

- Development build 0.1.33 keeps an unanswered managed write tied to its
  original tab when the same paired Chrome session reconnects, including after
  a Host restart. Another managed task stays queued or paused until the write
  is resolved. The original task still needs explicit continuation.

- Development build 0.1.32 admits one managed task per Chrome tab on a
  compatible authenticated connection. The Host checks ownership inside the
  start or continuation transaction. A competing task stays idle while the
  owner runs, stops, or has writes or recovery awaiting review. Other tabs may
  run tasks independently, including tabs that share a URL.

- Development build 0.1.31 shows a sidebar target only after the background
  reports the page state for that conversation. A panel without a registered
  conversation can see existing page grants. Switching conversations or losing
  the panel connection clears stale target and grant indicators until fresh
  state arrives. Reconnection restores the existing view and never submits a
  selection or browser action.

- Development build 0.1.30 expires diagnostic activation after ten seconds,
  before the panel RPC deadline. Late native replies cannot enable capture or
  replay expired queued activation. The native queue remains owned until its
  pending work and cleanup settle; another activation requires a new click.
  This bounds an independently reproduced failure mode, without establishing
  the cause of every historical native-enable timeout.

- Development build 0.1.29 retains the displayed conversation during worker
  bootstrap and transport reconnect. It restores only view registration and
  read-only history, without creating a conversation or replaying prompts,
  page selection, approvals or tasks. Explicit disconnection or a changed known
  Host address clears the old view and its reconnect cache.

- Development build 0.1.29 orders diagnostic-panel replies within their page,
  conversation and connection scope. Older polls cannot overwrite native
  start/stop results; polls wait for pending actions, and retired requests cannot
  clear a successor's busy state. Native activation remains required. The
  regression delays one read-only reply in a disposable extension copy and
  checks actual enable/read/stop, with an immutable build fingerprint.

- Page selection stops waiting after twelve seconds when its acknowledgement
  is missing, reports an unconfirmed result and refreshes status without
  replaying the request. The panel shows the background's specific error.
  Late outcomes cannot replace a newer selection's diagnostic record.
  Benchmark suite 36 records this feedback change.

- Development build 0.1.25 restores a panel’s latest window/conversation
  registration after its runtime Port reconnects. View restoration does not
  repeat new-session binding, move global focus or replay accepted actions.
  Late messages from replaced ports are ignored. Benchmark suite 34 records
  the reconnect scenario.

- Development build 0.1.24 scopes each panel’s selected-page and access status
  to its own conversation. An explicit group-page choice no longer depends on
  another panel being focused; stale revisions, foreign-session choices and
  page authorization remain checked. Unready conversations cannot silently
  accept a group-page choice. Benchmark suite 33 records this target change.

- Development build 0.1.22 task-progress tools document their evidence and text
  limits. Invalid reports
  return fixed correction guidance without echoing submitted data or changing
  saved evidence, user review or the version; the existing limits still apply.
  Missing write versions and malformed/oversized JSON also receive fixed
  correction guidance without echoing submitted data.
- A synthetic Host/default-model acceptance checks rejection of five evidence
  entries, unchanged saved notes, and correction by merging all five observations
  within the existing four-entry limit. This does not exercise business writes.
- Development build 0.1.21 lets drained, attributed ordinary conversations open
  or reuse an exact reference URL with a two-minute, one-use Host-owner admission while earlier site writes remain
  unresolved. The old records and write fence are preserved; page edits,
  navigation of the current page, closing tabs and managed tab mutations are
  still fenced. The admission is session/connection-bound, cannot be issued by model tools, and disallows forced copies. Direct follow remains fenced. Active writes and unresolved open/follow operations refuse
  target preparation, including after restart. Native permission checks and
  the durable write queue still apply to these recorded tab operations.
- Reconciliation failures now explain the pending-write review instead of
  reporting a missing execution context. Benchmark suite 31 separates this
  admission/guidance change. A synthetic smoke keeps an old failed site receipt,
  opens/reads a reference and checks that a save is refused before dispatch.

### Fixed

- Development build 0.1.20 reports native toolbar authorization failures instead
  of silently showing an empty page list. Pinned/unsupported pages, browser access,
  grouping, persistence and changed-page failures have fixed localized messages;
  raw browser errors are not retained. Outcomes stay in their original window,
  late attempts cannot replace later clicks, and closed windows are forgotten.
- The panel offers a read-only authorized-page refresh and per-window count.
  Refresh grants no page authority and does not change selection. Tab inventories
  explicitly mark authorized entries; `controlled` means selected, not permission.
  Benchmark suite 30 separates the inventory/guidance change.
- An isolated native Chrome smoke verifies the pinned failure, unchanged grants
  after refresh and successful grouping after an explicit unpin/toolbar retry.
  This does not identify the cause on the user's regular browser.

### Added

- Development build 0.1.19 binds snapshot references to native page, session and
  execution ownership, invalidates them after native pointer/key intervention,
  and reports bounded frame/collection coverage. Model projection is not attested;
  explicit model delta requests therefore return bounded full snapshots. This
  is a live DOM subset, not the complete generic observation envelope or automatic
  account/tenant identification. Benchmark suite 29 separates these semantics.
- Development build 0.1.19 adds native per-operation uncertainty review after
  a drained conversation and fresh same-connection observation. Human decisions
  remain separate from original facts/receipts and never verify criteria, replay
  writes or resume tasks automatically. Late receipts invalidate earlier review.
- Unconfirmed readback persists even after a successful tool receipt. Ordinary
  sessions retain their write fence across turns/restarts while scoped audit
  reads remain available. Expired managed contexts cannot fall back to chat.
- Host writes settle in a bounded per-session queue before later admission;
  explicit selected-page continuation also accepts reconciled blocked tasks
  while retaining their goal and cumulative limits.
- Development build 0.1.19 adds Chrome panel-owned Console/Network diagnostics.
  Native activation is scoped to the selected conversation and top document;
  the model has only a bounded read tool. Captures clear on control/document
  changes, disconnection, panel close or ten minutes. Records contain fixed
  error types, locations and route templates/statuses, never console messages,
  query values, original URLs, headers or bodies. Past events, child frames and
  workers are omitted; diagnostics do not verify business persistence.
- Diagnostic and visual reads share the owned debugger attachment. Read leases
  cannot evaluate scripts, request bodies or dispatch input; cleanup preserves
  the automatic DOM controller and existing screenshot owner. Both peers must
  negotiate the optional capability; old peers retain their existing tools.
- A local synthetic smoke exercises native activation/stop and one model tool
  read on isolated Chrome. Its scripted and default-model modes record separate
  evidence, including exact bundle hashes; neither establishes regular-browser
  or real-business acceptance.

### Test infrastructure

- Separate synthetic workflow, native observation and standalone upgrade smokes
  cover existing material tabs, model project edits and independent save/layout
  checks; trusted intervention and bounded coverage; and preserved history,
  pairing, notes and idle tasks in one disposable home/profile. Their evidence
  does not establish regular-browser or supplied-business-project acceptance.

- Component fixtures append markup through a template fragment instead of the
  unsupported ShadowRoot.insertAdjacentHTML. Both smokes require completed
  setup and verify actual sensitive field values before starting a model turn.
  The earlier 0.1.15 browser privacy claim lacked initialized fixture data;
  retained results are historical and that scenario needs the corrected check.
- An isolated write-boundary smoke checks native tool batches and parallel PTC
  submissions against delayed simulated-extension replies. Unconfirmed readback
  and failed write receipts must stop a second write while allowing observation;
  confirmed replies must permit both writes in order. This is SDK/Host runtime
  coverage, not real-browser, real-model or business-persistence evidence.
- Extension fixture setup waits for both saved settings and authentication to
  the intended Host. It reports settings failures immediately, bounds parent
  waits, records credential-free handshake metadata and can issue the one-time
  test code after panel startup. The continuity smoke logs phase progress and
  offers `--setup-only` without model requests. These checks remain separate
  from model and regular-browser acceptance.
- Test browser discovery checks an exact matching revision in the optional
  project-private cache before falling back to older cached browsers. Explicit
  browser overrides keep priority; the user's regular browser is not updated.

### Added

- Development build 0.1.16 lets a current control reference scope plain-text,
  layout and inspector reads to its own document or open shadow root. Scoped
  CSS must match uniquely within that tree and never falls back to the page.
  Text reads follow nested open roots and slot assignment, omit non-rendered
  prose and native field values, and redact before clipping. Incomplete bounded
  collection withholds text. Disabled observed controls can anchor reads while
  remaining unavailable for edits. Both peers negotiate `elementReadScope`;
  legacy document reads and wire version 4 remain. Benchmark suite 26 separates
  the expanded read interface. Closed roots, generated text and shadow-root
  rich-text edits remain outside this change.
- Development build 0.1.15 discovers native controls in accessible open shadow
  roots, including nested components. Labels resolve within their own tree;
  visibility, disabled/readonly checks and scroll contexts include hosts and
  assigned slots. Moving a node between components invalidates its reference.
  Native input notifications cross the host, and synthetic keys reach the
  focused internal control. Traversal is bounded; incomplete discovery is
  reported and uncertain sensitive-text inspection withholds page text.
  Body prose and CSS selectors remain document-scoped, closed roots remain
  inaccessible, and shadow-root rich-text edits are explicitly refused.
  Wire version 4 is unchanged; benchmark suite 25 records the expanded view.
- Development build 0.1.14 adds optional observation-bound vertical container
  scrolling to `browser_scroll`. A current control reference selects only its
  previously observed nearest scroll container; reaching its boundary never
  scrolls an outer container. Snapshots expose position context, and changed
  targets or unconfirmed position readback retain the existing write fence.
  Without a reference the legacy viewport path remains. The optional
  `elementScroll` capability prevents an older peer silently scrolling the
  viewport instead. Horizontal/reverse-flow scrolling and closed Shadow DOM
  are outside this change. Benchmark suite 24 separates the expanded tool.
- Development build 0.1.9 records bounded browser-operation feedback for the
  model and panel, including nested `run_code` results and restored history.
  It distinguishes precondition failures, dispatched actions, page readback
  and unknown results; none establishes a saved business change. Known stale
  references can be replaced after a fresh observation within existing access.
- Uncertain writes and unconfirmed field readback block further writes by the
  same Agent in that turn while permitting observation. A new user turn does
  not restore page grants or resolve an uncertain managed-run ledger entry.
- Development build 0.1.7 lets the panel import authorized control-group page
  titles and URLs into unsaved task-material drafts. Imported roles remain
  unknown; document URLs are deduplicated and use the shared credential-URL
  validation. Importing metadata does not save notes, change targets or start
  the model.
- Saved materials offer explicit existing-page selection for exact authorized
  document matches, including separate choices for multiple copies. Native
  selection rechecks the expected URL, pending navigation, page grant and
  conversation revision before binding. It creates no tab and does not reload
  the page. Unmatched links retain ordinary new-tab behavior and require page
  authorization before control. The optional field stays within the extension's
  panel/worker messages; the Host wire version and model tools are unchanged.

### Fixed

- Development build 0.1.18 binds delta snapshots to an explicit received
  `baseObservationId`. Missing, superseded, differently scoped/budgeted or
  render-clipped baselines fall back to full bounded snapshots. Snapshot regions
  require a unique document node. Automatic action feedback captures a control
  reference baseline before waiting, so intervening observations cannot become
  implicit bases; unanchored feedback is full, and clipped renders cannot seed
  another delta. Optional `snapshotBase` negotiation keeps wire v4 and full
  legacy reads. Benchmark suite 28 separates the expanded read contract; its
  Playwright backend continues to return full snapshots. This is not the full
  observation-envelope or recovery runtime.

- Development build 0.1.17 watches nested open shadow roots during bounded
  DOM settling, including roots attached to existing hosts while waiting.
  Continuous changes or incomplete bounded inspection report unsettled and
  invalidate old references instead of publishing an automatic delta. Detached
  roots no longer prolong the wait; observers and timers are released. Frequent
  mutations cannot repeatedly postpone the pending deadline check. This
  does not establish network/framework readiness, property-only updates or a
  business save. Wire version 4 is unchanged; benchmark suite 27 records the
  expanded wait semantics.

- Development build 0.1.13 reads back the rendered plain text of rich-text
  inputs, marking rollback or mismatch unconfirmed. A present editing command
  that rejects or throws is never followed by a direct DOM write; only an
  absent command retains that fallback. A cancelable synthetic beforeinput is
  offered first; focused selection and editing-host identity are rechecked,
  and native inputs nested in editable regions keep their native value path.
  Plain-text readback does not verify editor formatting, framework state or a
  business save. Benchmark suite 23 separates these feedback semantics.
- Development build 0.1.12 refuses direct edits to native or ARIA readonly
  fields, including native single-selects. A field that becomes readonly during
  editing retains the unconfirmed-result fence. An initially readonly field is
  reported as not applied, allowing other writable controls to be handled.
  Readonly editor state is visible in control inventories and deltas. Native
  readonly text inputs can still be clicked as intended picker triggers.
  Benchmark suite 22 separates the new readonly feedback from older results.
- Development build 0.1.11 marks partial select changes as unconfirmed when
  page event handlers change the control or its options. Input, textarea,
  rich-text and select actions also recheck target identity after settling.
  These results retire old references and reach the existing Host write fence,
  allowing observation while preventing further writes in that turn. They do
  not undo an edit or establish business persistence.
- Development build 0.1.10 preserves Host-proven unsent refusals through
  capability, execution-context and durable-preparation failures and local
  design-view guidance. These no longer imply that the current write may have
  reached the page. This does not clear earlier unknown writes or bypass an
  approval/run boundary; extension-reported text cannot establish this fact.
- Tool history and live settlement use rc.5's `message.toolCallId`, including
  when PTC feedback or partial replies separate the call and its result.
  Received tool results no longer appear pending merely because of that shape.
- Development build 0.1.8 shows failed Host turns in the conversation immediately
  and when restoring history. Fixed localized copy distinguishes structured
  HTTP 429 responses without displaying provider diagnostics. Earlier durable
  replies remain visible; the panel ends its busy state and allows another
  user message, without adding automatic retries or replaying browser actions.
  A tool without an observed result is labelled unconfirmed after the turn
  ends, rather than being presented as completed.
- Development build 0.1.6 retains the real Session before an explicit task-note
  save, without sending a prompt. Notes saved before the first message remain
  discoverable after restart. Legacy orphan notes appear in extension history;
  explicit selection restores an idle default-workspace Session, never a
  workspace from saved metadata or invented messages. Same-connection note
  mutations and prompts preserve their arrival order per Session.
- Unsaved task-note drafts survive reconnects and settings/conversation switches
  in the same panel lifetime, isolated by Host and Session. The original version
  is retained for conflict checks; drafts are not auto-submitted or persisted
  across full panel/browser reloads. Unpairing and successful deletion clear
  the relevant draft cache.
- Task-note read/write faults no longer block ordinary Agent steps. A startup
  notes fault leaves the browser bridge available with an explicit panel error.
  Model guidance treats missing notes as unavailable, not empty or completed;
  browser authorization and uncertain-write fences remain unchanged. Session
  deletion refuses unavailable note storage. Isolated continuity checks now use
  the product's default deferred creation, cover pre-prompt saves and restarts,
  and inject write/startup faults only into temporary storage. Benchmark suite 21
  records the changed model-facing fault guidance and validation semantics.

### Added

- Development build 0.1.5 adds session task notes for a project path, up to eight
  relevant material links and sixteen acceptance criteria. Notes persist in a
  profile-specific Host storage domain, are projected into subsequent Agent
  steps and can be edited in the side panel. A model helper records inferred
  notes and criterion reports; user-edited notes reject model replacement.
  Version checks reject stale updates. Paths and saved links grant no access.
- Criterion reports distinguish implementation, model-observed evidence,
  uncertainty and next steps. Native panel review records a user's confirmation;
  changed reports or requirements invalidate affected confirmations. Markdown
  export retains this provenance. Reports do not change managed-run verdicts.
- Connected settings show installed Host, extension, DSH and wire versions.
  Optional metadata remains compatible with older wire-v4 peers; differing
  package versions prompt a coordinated update without claiming protocol failure.
  `release:prepare` creates a standalone Host tarball, Chrome ZIP, checksums and
  local installation instructions from public sources and selected build files.
  This prepares local development artifacts; it does not publish a supported
  release, browser-store update or GitHub-root plugin package.
- `test:smoke-session` checks chat without a page, tab closure, history selection,
  worker replacement and temporary Host restart using isolated Chrome. Its opt-in
  default-model path also checks task-note readback, reported evidence and native
  user review on a synthetic page. These are separate from regular-browser acceptance.
  Benchmark suite 20 records the new helper and continuation guidance.

- Custom dropdown snapshots expose ARIA options and the observed Element UI
  popup/list-item shape, with selected/disabled state and visible-popup
  priority. Option references retain the existing observation/action guards,
  include popup identity and reject hidden/disabled or changed targets. Common
  control keys also carry legacy event fields without providing native keyboard
  defaults. The widget smoke checks real Host dispatch and background hash-route
  rendering for manual and automatically controlled tabs; its optional default
  model must select, save once and navigate against independent synthetic server
  state. This does not certify every SPA or real backend. Benchmark suite 18
  records these model-facing inventory, event and guidance changes.

- Material guidance preserves conflicting source values, follows explicit user
  precedence and keeps read-only project tasks read-only. Three additional
  synthetic default-model cases verify unresolved/resolved conflicts and a
  disposable project's unchanged bytes with scoped read/write/edit tools
  available. The test-only synchronous file guard rejects paths outside that
  fixture. Benchmark suite 17 records these changes; this is not evidence of
  real-project editing or integration.

- Material roles follow the task and observed content, including embedded designs
  in prose and Wiki pages requested as implementation targets. Tool descriptions
  no longer exclude Wiki styling by name. Three independent synthetic model
  cases share the same tool set; per-case report schemas reject extra/missing
  fields at every depth and tolerate object-key reordering. Benchmark suite 16
  records these guidance and acceptance changes.

- Shared guidance distinguishes supplied projects, visual references and Wiki
  requirements. Document-reader themes are not product visual requirements.
  Synthetic default-model checks cover material roles and observed-control
  recovery; they do not establish user-project code editing or integration.
  Benchmark suite 15 records these guidance/tool/error-semantics changes.
- `browser_set_design_zoom` supports labelled native selects and the observed
  Lanhu detailDetach zoom menu, with exact bounded percentages and readback.
  The menu uses two extension-private steps under one tool call; selection
  repeats the original authority/document checks and consumes an expiring DOM
  pin. Cancellation after opening blocks the remaining selection, and a missing
  selection receiver cannot replay the first step. Lanhu requires a foreground
  page and a visible popup; background pages receive a specific error before
  menu effects. A packaged no-selection error permits fresh observation and
  another supported method. Unknown-effect failures retain the Agent-local fence until a new user
  turn; older peers remain conservative. The existing optional wire-v4 capability
  remains compatible. Suite 13 introduced the native tool; suite 14 records the
  menu adapter and controlled fixture/guidance changes. The default model also
  changed a real Lanhu toolbar from 27% to 150% in a separate controlled test
  tab in regular Chrome, with independent percentage readback and the original
  tab unchanged. This does not certify canvas rendering or full-page fidelity.
- “Skip action confirmations on authorized pages” is enabled by default for new
  settings or records without this preference. Saved false/true choices remain
  unchanged. Native page grants and target/revocation checks still apply; the
  setting grants no access to other pages. The panel and worker use the same
  default. The sharing selector shows the effective Auto policy while enabled,
  retaining the saved sharing choice for when bypass is turned off. Benchmark
  suite 12 records this default-policy change separately from layout-tool suite 11.
- `browser_measure_layout` reads unique rendered DOM boxes, computed CSS spacing,
  aligned edge gaps and contained-box insets without changing page state or
  reading field values. Missing/ambiguous/unrendered selectors fail; unmeasured
  gaps remain null. Both peers negotiate optional wire-v4 `layoutMetrics`;
  older peers receive update guidance. Read approval, sharing and execution
  fences remain in place, and an insufficient text budget cannot produce
  successful partial JSON. `test:smoke-layout` exercises the selector/spacing
  regression on synthetic pages in an isolated Host and Chrome, with an optional
  existing-default-model check. Both checks passed the actual 0px/50px before/after
  gaps, with independent browser readback; this does not measure hidden canvas
  layers or certify full-page fidelity. Benchmark suite 11 records the new tool and guidance.
- `browser_read_design_styles` reads explicitly labelled inspector properties
  through the existing authorized text tool. Reports retain source evidence,
  missing fields and conflicts; background/text layers are not merged and
  truncated reads cannot yield style values. The initial bilingual label parser
  does not infer hidden metadata, units or font weight, or generate CSS.
  Synthetic browser checks cover layer switching and native page revocation;
  the existing default model has used the helper for both layers and reported
  exact synthetic metrics. General real-site compatibility needs separate acceptance.
  Benchmark suite 8 records the model-facing tool and guidance change.
- Plain page-text reads preserve rendered line breaks for inspector label/value
  pairs. Sensitive copied values remain redacted across whitespace changes.

### Fixed

- Explicit session project directories are no longer replaced with the default
  browser-session workspace. Starting a project conversation from saved notes
  creates a new Session with that directory; saving notes alone leaves the
  existing Session's workspace unchanged.

- Side-panel chat no longer requires a live browser tab. New conversations
  without an authorized page and conversations whose page was closed or
  unbound can send messages. Existing selected-page snapshot ordering and
  browser-tool target/authorization checks remain in place.

- Browser guidance checks authorized tabs before opening a supplied document.
  Ordinary `browser_open_tab` calls reuse a matching authorized URL without
  reloading it; `newTab: true` requests a separate copy. URL matching retains
  document IDs, query values and SPA fragments. Multiple matches require a
  choice unless the session already targets one. Unauthorized pages, revoked
  grants and managed-run restrictions retain their existing boundaries.
  Selected-page context does not make unrelated controlled tabs additional
  task sources.
  Benchmark suite 19 records these tool and guidance semantics.

- Equivalent HEX/RGB colors and percentage/scalar opacity values share one
  inspector field while retaining both sources. Decimal alpha conversion avoids
  division artifacts, and distinct values still conflict. Reads whose recognized
  fields are all withheld are `partial`, not `unrecognized`. Benchmark suite 10
  records the model-visible report changes.
- Direct visual-smoke preparation uses a temporary Agent-scoped native tool
  presentation instead of recording PTC dispatches outside a turn. Its preset is
  restored after success or failure; running/model-test Agents cannot be used for
  preparation. The smoke also checks that the resulting Session history is readable.
- Inspector style reads recognize plain-color `background`, one-to-four corner
  radii and HEX swatches with alpha percentages. Named-color rows keep their
  original evidence. Inspector `fontFace` and CSS `fontFamily` remain distinct,
  preventing false conflicts without inferring font weight from a name.
  The existing default model completed both layer reads on the inspected Lanhu
  page in regular Chrome after enlarging its view; other layouts remain unverified.
  PTC guidance passes an empty object to tools with no arguments. Benchmark
  suite 9 records the model-visible report and guidance changes.
- Design-to-code guidance checks selector matches and rendered spacing, treats
  unmeasured margins/padding/gaps as unknown and preserves existing spacing
  unless observed evidence supports a change. Declared CSS or an unverified
  fidelity percentage cannot establish a correct layout.
- Approval timeouts and unavailable panels stop further browser requests from
  that Agent until a new turn, without affecting other conversations or treating
  ordinary page/transport timeouts as approval failures. Shared model guidance
  asks the user to return to the extension; benchmark suite 7 records the change.
- When authorized group pages exist without a selected conversation target, the
  panel asks for page selection instead of repeating authorization instructions.
  The synthetic visual check now separates background and text properties and
  checks same-page design switching, old-point rejection and fresh image readback.

- Design-page guidance separates background-layer dimensions, fill and radius
  from text-layer font metrics, and uses explicit inspector values for font
  weight. Benchmark suite 6 records the shared model-prompt change.
- Canvas points with invalid coordinates or unavailable screenshot ownership are
  rejected before action confirmation. Denying a valid point keeps its reference
  available, while references replaced during approval are still refused at
  delivery. These checks do not bypass page permission or action approval.
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
