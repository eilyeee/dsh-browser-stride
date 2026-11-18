# Browser extension

In 0.1.31, the sidebar displays the current target from its registered conversation. Before registration, it can list authorized pages without showing another conversation's target. A conversation switch or panel connection loss clears the old display until the background supplies fresh state. After reconnecting, an existing target can reappear for the same conversation.

In 0.1.30, diagnostic activation expires after ten seconds. A late native reply cannot activate capture or replay an expired queued request. Pending native work retains its cleanup slot; after cleanup, enabling again requires another actual click. `pnpm run test:smoke-diagnostics-expiry` delays one completed native enable reply in a disposable extension copy and checks expiry, confirmed cleanup and explicit reactivation on a local synthetic page. It does not identify every historical enable-timeout cause or replace regular-browser acceptance.

In 0.1.29, worker bootstrap and transport reconnect retain the displayed conversation and refresh its registration and history read-only. Failure keeps the conversation and shows a notice rather than creating another one. Explicit disconnect or a changed known Host address clears the previous view. Restoration neither grants page authority nor replays selections, approvals, tasks or prompts.

In 0.1.29, diagnostic-panel replies are ordered within their page, conversation and connection scope. An older poll cannot overwrite a newer native start/stop result or clear another scope's pending state. Polling waits during an action; scope changes retire prior requests. Actual clicks are still required and actions are never automatically retried. `pnpm run test:smoke-diagnostics-status` delays one read-only reply in a disposable extension copy while testing native enable/read/stop. It does not replace regular-browser acceptance.

In 0.1.28, trusted pointer/key input fences writes in affected ordinary conversations as well as managed tasks. Reads remain available, but a fresh snapshot, model target switch or new page cannot acknowledge takeover. Inspect the account, workspace and current result, then explicitly select the intended group page; managed tasks still require their continuation control. The deny fence survives worker restart in extension session storage without restoring prior acknowledgements. This does not identify every silent account/tenant change; authoritative site integration is still required.

The 0.1.28 uncertain-operation list adds operation time, bounded type and review reason without retaining input values or page text. An error reply does not prove the action had no effect. Late replies require renewed review. Decisions remain unset until the user inspects the actual result.

In 0.1.21, a drained ordinary conversation with a one-use Host-owner admission can open or reuse its exact reference URL for observation while old site-write uncertainty remains. Original records and the page-write fence are preserved. Page edits, submissions, current-page navigation, tab closing and managed tab mutations remain fenced. Active writes or an unresolved open/follow refuse another target change. The admission lasts two minutes, belongs to one session and connection, disallows forced copies and cannot be issued by browser tools. Direct follow remains fenced. Existing native permission/approval checks, durable records and write ordering still apply; this neither acknowledges old operations nor resumes a task.


## Connected but pages are missing

In 0.1.20, **Page connection check** shows the current window's authorized-page count and last toolbar result. Failures automatically reveal a fixed message for pinned/unsupported pages, browser access denial, grouping, storage or changed pages. Raw browser errors and page content are not retained. Other windows and late attempts cannot overwrite the current window's newer result.

**Refresh authorized pages** rechecks existing grants without granting access or selecting a target. Connecting to the Host, opening the panel or dragging a page into the group does not grant access. Unpin a pinned tab before clicking its toolbar icon. A missing toolbar record is different from a failed attempt.

In a model inventory, `scope: authorized-tabs` means the entries were filtered by existing authorization; new entries also report `authorized: true`. `controlled` only identifies the selected target, so false does not mean unauthorized. Dispatch still checks current authority and target separately. `pnpm run test:smoke-page-authorization` checks native failure, read-only refresh and explicit retry on disposable Host/Chrome; regular-browser acceptance remains separate.


Development build 0.1.19 binds observations to the native page lifetime, conversation and managed execution revision. A trusted pointer/key event in a controlled page retires old observations: the model must read again, and a managed task needs explicit continuation. This does not detect every background account or tenant change. Login and business identity still need independent checks; model-generated events never grant authority.

Bounded snapshot metadata reports listed frames, native document epochs and omitted text/controls/options. `complete` is always false: closed roots, hidden canvas layers, non-DOM state and unlisted frames are outside the evidence. Recognized-value redaction does not mean all personal information is removed. Missing legacy metadata remains unknown. An observation ID cannot prove the model received a complete baseline, so explicit model delta requests currently return bounded full snapshots with `model-projection-not-attested`. Trusted lower-level protocol baseline checks remain. The 0.1.18 description below is historical.


Development build 0.1.19 also adds **Review uncertain operations**. Stop the conversation/task, request a read-only page check, then inspect actual business records and decide each listed item yourself. Unknown is the default. Recording review does not replay, resume or verify the task; a late reply requires another review. Use an explicit selected-page continuation after review. Model/page text cannot submit this native decision. Offers expire after five minutes; this is manual reconciliation, not automatic recovery.

Development build 0.1.19 adds opt-in **Page diagnostics** in Chrome. A real panel
click enables error types/locations and Network status metadata for the selected
conversation and document; `browser_get_diagnostics` only reads this capture.
It stops on navigation, control changes, disconnect, panel close or ten minutes.
No message text, original URL, query values, headers or bodies are returned.
It is a partial troubleshooting view, not a persistence or task-success check.
Firefox does not offer this optional capability. Use `node scripts/smoke-diagnostics.mjs`
for an isolated Host/Chrome check; `STRIDE_REAL_MODEL=1` uses the private model
configuration described below. Isolated acceptance is separate from regular Chrome.

Development build 0.1.18 requires `baseObservationId` with `delta=true` to
produce a delta. Copy the last received Observation ID. Each frame independently
requires a matching current baseline, the same live text region and budgets, and
a previous render without character clipping. Otherwise it returns a full
snapshot within the usual limits. Full means non-delta, not complete page
coverage. Regions must match exactly one document node.
Automatic action deltas retain a reference-bound baseline captured before the
action waits; unanchored or superseded reads return full observations. Clipped
automatic responses cannot seed a later delta. Both peers negotiate optional
`snapshotBase`; old calls without a base remain full reads. This is incremental
baseline checking, not the full observation-envelope or task-recovery runtime.

Development build 0.1.17 extends bounded DOM settling to nested accessible open
shadow roots, including roots attached while waiting. Continuous changes or
incomplete inspection return unsettled. Action readback and explicit waits then
suppress automatic page deltas and retire old references. Detached roots do not
prolong the wait. Limits apply to 50,000 inspected elements, 64 roots and
16 root levels; cumulative subscriptions are capped at 64 per wait. Observers
and timers are released on completion. Mutation callbacks coalesce without
postponing the wait deadline. This does not establish network or
framework readiness, closed-root state, property-only changes or business saves.

Development build 0.1.16 lets `browser_get_text`, `browser_measure_layout` and
`browser_read_design_styles` accept an optional current control `elementRef`.
It scopes selectors to that control's own document or open shadow root; scoped
selectors must match exactly once. Text follows nested open roots and assigned
slots, with sensitive-value redaction before clipping. Traversal/text limits
withhold incomplete text. Both peers must negotiate `elementReadScope`. Omitting
the reference keeps legacy document behavior. Snapshot prose/regions still use
the document; closed roots, CSS-generated text and shadow rich-text edits remain
unsupported. Layout reports use the current frame's viewport coordinates.

Development build 0.1.15 includes native controls inside open Shadow DOM in
snapshots. Internal labels stay scoped to their tree; hidden, disabled, readonly
and inert host/slot boundaries still apply. A control moved between components
needs a new reference. Recognizable sensitive values are masked, including copies
in document text; if bounded inspection is incomplete the text is withheld.
Without an observed read scope, prose and CSS selectors remain document-scoped. Closed roots and shadow-root
rich-text editing are not supported. Synthetic keys target the focused internal
control without guaranteeing native keyboard behavior.

Development build 0.1.14 adds vertical container scrolling: `browser_scroll`
accepts an optional current control `elementRef` and scrolls only the nearest
container captured with that observation. Snapshot items show `scroll-container`
position context. The scroll stops at that container's boundary; it never falls
back to an outer container or the viewport. Both peers must negotiate
`elementScroll`. Omit the reference for the existing viewport behavior. Position
readback does not verify loaded content or persistence. Horizontal scrolling,
reverse flow, vertical writing and closed Shadow DOM remain outside this path.
A container needs an observed control to target; text-only areas without one
are not independently discovered by this feature.

English | [中文](README.zh.md)

The Chrome/Firefox extension contains a background bridge client, content scripts for text snapshots and page actions, and a React side panel. It works with the local Bridge in this workspace; it does not install or start a Host by itself.

See the [repository README](../../README.md) for installation, one-time pairing, security and feature status. Chrome and Firefox need separate installation credentials. Chrome supports viewport screenshots and screenshot-bound synthetic points. Native CDP input and webpage file transfer remain unavailable; Firefox retains the text path.

The Firefox build uses a provisional extension ID distinct from the upstream extension. It is not a published Firefox release.

Wire protocol v4 requires the matching Host build. Commands carry an action id, a digest and an explicit legacy/run scope. The digest is checked before an extension-origin IndexedDB transaction commits an execution fence. After admission and any write turn, the extension confirms the original pending request with the same Host connection; a copied run id or late reply cannot renew authority. Browser permissions still apply. The same id is never executed twice while its fence is retained, including after worker restart; changed commands are refused. Only identity, timestamps and admission/finish phase are stored. Page/input text and previous result payloads are not cached. The store holds up to 5,000 fences with no automatic expiry or eviction; Unavailable or full storage blocks new execution; a corrupt existing fence blocks its action. Clearing browser/extension data removes this protection. These fences do not replace user permission, live target checks or business-result verification, and there is no automatic recovery/replay.

## Task materials and acceptance

**Task materials and acceptance** persists the conversation's goal, project directory, up to eight material links and sixteen criteria. The model can organize notes until a user edits them, then report evidence per criterion without replacing user corrections. History and Host restarts retain these records without restoring browser grants or replaying operations. Model reports, user reviews and managed-run verdicts remain separate, including in Markdown exports. A path is context; **New chat in this project** explicitly creates another Session in that directory. Version checks prevent stale saves or reviews.

Settings show Host, extension, DSH and wire versions. See the repository's [update instructions](../../README.md#updating) for development artifacts; update the Host and extension separately.

## Development

Matched development build 0.1.9 adds bounded operation feedback to native and
nested browser results. The panel distinguishes an operation being sent from
its page readback and from an unknown result. These states do not verify a
business save. A known stale precondition permits a fresh observation and an
alternative within existing access. After an uncertain write or unconfirmed
field readback, the Agent can still observe but cannot issue another write in
that turn; it must explain the uncertainty and ask the user. This supplements
the existing ledger and does not add checkpoint recovery or automatic replay.
Login or CAPTCHA handoff depends on the model's observations; this build does
not provide a general authentication detector. Page text never grants access.

Development build 0.1.10 also distinguishes Host-proven refusals before dispatch
from unknown results after dispatch. Existing approval and run restrictions
remain in force; an unsent refusal does not reconcile any earlier write.

Development build 0.1.11 also marks field edits as unconfirmed when event
handlers change the target or select options, including during settling. Old
references are retired and the same-turn Host write fence remains active after
a fresh observation. A partial edit is not undone by this check.

Development build 0.1.12 checks native and ARIA readonly state before direct
field edits and during selection. A pre-existing readonly field is refused
without stopping edits to other writable fields; a field locked after partial
editing keeps the uncertainty fence. Readonly text inputs used as picker
triggers can still be clicked to open their intended menu.

Development build 0.1.13 verifies rich-text edits by reading their rendered
plain text. Rollback or mismatch keeps the unconfirmed-write fence. A failed
or throwing editing command is not retried with direct DOM replacement; that
fallback is limited to hosts without the command. Text readback normalizes
line endings and editing-space variants, and verifies neither formatting nor
framework or business persistence.

Before a rich-text edit, the bridge offers a cancelable synthetic beforeinput and checks focus/selection again. Browser-emitted events remain available to the page.

From the repository root:

```sh
pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run typecheck
pnpm --filter dsh-browser-extension run test
```

Chrome output is `extensions/dsh-browser/dist/`; Firefox output is `extensions/dsh-browser/dist-firefox/`. The repository installer prepares the `web` Host profile and Chrome extension. For Firefox, also run the Firefox build above, open `about:debugging`, select **This Firefox** → **Load Temporary Add-on**, and choose `extensions/dsh-browser/dist-firefox/manifest.json`. This installation lasts until Firefox restarts; see [Mozilla's temporary installation instructions](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/). Pair the Firefox installation separately using the root README's instructions.

The only declared host permission is `http://127.0.0.1/*` for local DSH communication. Chrome also declares `debugger` and `tabs`: these provide broader browser capabilities than `activeTab`, including tab metadata. Stride limits model-visible tabs and debugger attachment in application code; it does not claim browser-enforced per-tab isolation for debugger control. Firefox retains `activeTab` without these Chrome permissions. Scripts are loaded only for authorized pages. Page content is untrusted, and state-changing actions follow the approval settings. DOM click, type and select require an element reference from the latest observation; coordinate clicks instead require a fresh screenshot reference bound to the original conversation and managed control revision. Neither reference identifies an account or tenant; tool dispatch retains its separate execution checks.

The side panel shows metadata for Host-created browser runs in the current conversation, with explicit Pause and Stop controls. A stop request remains Stopping until its executor confirms. For a paused run with settled writes and no recovery requirement, select an authorized group page using the control above the conversation, then click **Continue on selected page**. This uses the selected native group page and advances the run's control revision; it does not revive old execution contexts. The executor must pick up the updated run in a fresh context. DSH Web's `/browser <goal>` command creates an explicit waiting task. Select that conversation in the history picker, select the intended browser page and click **Bind and start**. This real user action revalidates and binds the native page before the Host starts its Agent; reading history or reconnecting does not start it. Waiting tasks stay selectable even before their first model turn. Ordinary chat does not automatically create tasks, and automatic reconciliation is not implemented. Controls require real user input, carry the displayed record version and are never automatically retried. Hosts without the optional `canRetarget` capability do not show the continuation button.

Ordinary chat does not require a bound page. You can send messages in the same conversation without an authorized page, after its tab closes or after unbinding it. Browser tools separately check their selected target and page authorization. Sending a message does not select another page or restore revoked access.

If the Host ends a turn with an error, the conversation shows a failure notice immediately and retains it in history. Structured HTTP 429 failures have specific copy; raw provider diagnostics are not displayed. Earlier durable replies remain visible. Tools without a recorded result show **Result unconfirmed** after the turn ends. The panel leaves its busy state and permits another user message without adding automatic retries or replaying actions. A failure notice does not establish whether an earlier browser operation succeeded; check its result before asking to repeat it.

Tasks retain cumulative limits of five active minutes, ten model-request admissions and twenty browser calls. A task already at any limit cannot start or continue; the panel keeps **Stop** available and explains how to create another task for remaining work. Pausing or choosing another page does not reset these counters. Already admitted work may still finish independent verification.

With the updated Host, a normal Host restart allows automatic transport reconnection while the side panel is open, using the existing pairing. A connection replaced by another client still needs **Save and connect**. Reconnecting does not resume an interrupted task or restore its old page binding; Host task recovery is not implemented.

With both components updated, **Stop controlling this page**, tab closure or a lost native binding also pauses the corresponding task and cancels its Agent. Confirmed page revocation keeps DSH connected and leaves the page open. Authorize and bind the intended page again, then explicitly choose **Continue on selected page**; permission alone does not resume work. Already-started actions cannot be undone, and pending or uncertain writes still block continuation. If the Host cannot confirm a revocation notification, the worker closes its original connection so the Host handles connection loss. Older compatible peers keep their generic paused metadata; immediate page-loss pause requires the negotiated `taskTargetLoss` capability.

Use **Unpair DSH** in extension settings to disconnect this browser. It removes the local credential and disables automatic reconnection across panel, worker and browser restarts. When the Host is reachable, it also revokes this installation’s credential and cancels its outstanding pairing requests. If the Host cannot confirm revocation, the UI reports local removal only. Pages and conversations stay open; reconnecting requires explicit pairing.

Losing the browser connection pauses explicit tasks pinned to that connection and cancels their active Agent scopes. Reconnecting alone does not continue them. Select the original conversation from history, confirm the page's control access and binding, then click **Continue on selected page**. Uncertain, failed or pending writes still block continuation, and Host restart recovery remains unavailable. If another client replaced this connection, use **Save and connect** to reconnect with the same address and credential. Policy-only saves and keepalive do not reclaim it.

If the Host confirms that **Bind and start** or selected-page continuation was refused before the Host registered that target, the extension releases that attempt's unused binding record. After refreshing task status, another trusted click can prepare a fresh binding. A lost or uncertain reply retains the original binding and never causes an automatic retry. This cleanup preserves the page and its native permission.

Continuing a task clears its previous outcome message while preserving cumulative limits and saved evidence. A late verifier from an earlier activity cannot make the running continuation display “Needs verification; automatic actions have stopped” or “Result independently verified”. The current activity is verified separately.

“Skip action confirmations on authorized pages” defaults to on when no choice has been saved. Saved false/true preferences survive updates and worker restarts. While enabled, authorized page content is shared automatically; the disabled sharing selector displays Auto, retaining the previous choice for when this setting is turned off. Turn it off and save to restore that sharing policy and normal action-confirmation rules, including trusted-domain exceptions. This does not grant page access or bypass target/revocation checks.

## Authorizing one page

For an existing page, open it and click the **DSH Stride toolbar icon**, then select the task and its authorized group page and choose **Bind and start** in the side panel. Opening the sidebar through the browser menu, clicking a sidebar button or sending model instructions cannot authorize an existing page. Same-site sibling tabs require their own toolbar click. Newly created Chrome pages have the separate opt-in flow below.

Authorized tabs join the blue **DSH 控制** group, managed separately in each window. Dragging an unapproved tab into the group grants no access and removes that tab from the group. Dragging an authorized tab out or choosing **Stop controlling this page** revokes Stride control. On Chrome, control requires successful group membership. Pinned pages must be unpinned first; a grouping failure leaves the page unauthorized. Firefox retains its existing per-page permission path; group-only Chrome behavior has not been validated on Firefox. Stop control is also available before binding a task. Stopping does not undo already-dispatched effects or remove DSH pairing. Worker recovery rechecks the native tab, site and group; stale cached grants cannot replace a committed revocation. If the cache is inconsistent, authorize the intended page again. The browser's temporary permission expires on navigation or closing; the stop button immediately revokes Stride authorization and deactivates the page script.

Cross-site navigation, closing a tab, extension reloads and browser restarts require another toolbar click. Chrome retains temporary access across same-origin reloads; Firefox requires authorization after a new document loads. Page grants are not restored after browser restart, and group membership is never authority. Cross-origin iframe content is outside the temporary grant; when injection is unavailable, only the accessible main document is handled. See [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab) and [Firefox activeTab](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/activeTab_permission).

Run `pnpm run test:smoke-page-access` to check page permissions and grouping with a disposable Chromium profile and synthetic local sites. It calls no model and uses no daily browser profile. This check needs Chrome for Testing with `Extensions.triggerAction` support.

Chrome no longer offers human-tab following or keep/follow prompts. Click a page in **DSH control group** above the conversation to select an authorized group member. The list excludes unapproved pages, and selecting a page does not activate it in the browser. New conversations choose an existing authorized group target; starting a queued task uses that selection even while you browse elsewhere. Managed tasks never change their pinned target merely because human focus changes. Dragging a page out still revokes control and pauses its task.

If authorized group pages exist but this conversation has no selected target, the panel asks you to select an existing page rather than authorize it again. If an approval times out or no panel can receive it, the Host blocks further browser requests from that Agent for the rest of the turn. Return to the extension and send a new message to retry; the new request still requires confirmation. Other conversations are unaffected.

## Custom dropdowns and control keys

Expand a custom dropdown, take a fresh `browser_snapshot`, then use `browser_click` with the visible option's `elementRef`. Snapshots include ARIA combobox/option controls and the observed Element UI select popup/list-item structure. Visible popup options take priority over modal and background controls under the inventory cap; disabled and selected states are shown. Ordinary list items are not inferred to be controls. Hidden/disabled options and changed option labels or popup containers cannot reuse an actionable reference. `browser_select` remains limited to native HTML selects. These DOM adapters retain existing page authorization, observation and action-confirmation checks; they do not read framework internals.

`browser_press` includes `code`, `keyCode` and `which` for common named control keys so legacy page handlers can respond. Events remain synthetic: Tab does not provide native focus movement and Enter does not provide native form submission. Observe the page after each operation.

Run `pnpm run test:smoke-widgets` for a temporary Host and isolated Chrome check covering option references, disabled/closed options, legacy key handlers, and rendered hash-route changes in background manual and DSH-created tabs. `STRIDE_REAL_MODEL=1` adds the existing default model choosing, saving once and navigating, checked against independent server state. It uses the same optional private model inputs as material acceptance below, with at most twenty model requests and thirty browser calls. Evidence stays under `.stride-private/validation/widgets/`. The fixture reproduces observed DOM shapes, not a complete UI library or real CRM backend. This does not establish every SPA's navigation or Desktop integration. Rebuild both components, restart the Host and reload the extension to use the new guidance and references.

## Canvas and design pages

With both components updated, Chrome offers `browser_screenshot` and `browser_click_at`. Authorize the design page and select it in **DSH control group**. The screenshot captures that native tab, including when you browse elsewhere; it never follows human tab focus. Screenshot sharing uses the page-sharing setting, and points use action approval/trusted-domain settings. Images include the full visible viewport, including embedded pixels; DOM text redaction does not redact screenshot pixels.

A screenshot is stored through DSH’s image attachment service and appears as an image on the next model step, including calls nested inside `run_code`. It does not put base64 bytes or filesystem paths into tool text. Use an image-capable model; text-only models receive DSH’s image limitation notice. Read the image first, then call `browser_click_at` with its `screenshotRef` and **x/y fractions of the complete image**, each from 0 inclusive to 1 exclusive. For example, a point at one quarter of the image width and halfway down is `{ x: 0.25, y: 0.5 }`. Fractions remain correct when the Host or model resizes the whole image.

For a design canvas, select a layer using a screenshot point, then read `browser_snapshot` for the displayed inspector values. This works with page-provided layer data; an uploaded flat image does not acquire hidden layers or exact CSS. Points send synthetic pointer/mouse events to one main-document element, including canvas or SVG. They do not provide native gestures, dragging, iframe coordinate input, full-page capture or design-file export.

If a design is too small to locate its layers reliably, call `browser_set_design_zoom` with a percentage from 100 to 200. It supports a uniquely labelled native HTML zoom select and the observed Lanhu `/web/#/item/project/detailDetach` toolbar/menu. Keep the Lanhu page in the foreground; switching it to the background blocks an undispatched menu selection. Choose an offered preset such as 100%, 150% or 200%; unsupported values are not rounded. The adapter enters the exact zoom toolbar, finds its visible anchored percentage menu, then rechecks the original request, page grant and document before selecting. Opacity fields and non-percentage zoom commands are excluded. It reads back the toolbar percentage and requires a fresh screenshot before layer points. It does not change CSS or browser zoom. Parallel browser calls are blocked during preparation. A packaged `design-zoom-not-selected` preflight error permits a fresh observation, another supported control or a request for missing conditions; do not repeat unchanged failures without new evidence. Selection/readback failures and unknown transport effects retain the durable write fence; a new user turn alone does not clear it. Read-only inspection and native review are required. Page text cannot release the fence; older peers without the signal retain conservative stopping. Cancellation or control revocation after menu opening prevents the undispatched selection; an already opened menu may remain, and completed effects are not undone. Read a component’s background and text layers separately. Click background padding to inspect container dimensions, fill and corner radius, then take a fresh screenshot and select the text to inspect font metrics. Keep those values separate and report the inspector’s explicit font weight rather than inferring it from a layer or font name. After switching designs, take a new screenshot and verify the selected layer in the new design before reporting its properties.

Screenshot refs are single-use, memory-only and bound to the original conversation, document, grant, connection and managed control revision. A new capture supersedes that page’s earlier reference, including across conversations. Scroll, resize, zoom, observed DOM changes and page input invalidate them. An animated canvas may redraw without a DOM event; take a new screenshot before acting and verify the resulting inspector. A point is not proof that the intended layer or business operation succeeded.

Invalid image fractions, used references and references owned by another conversation or expired authorization are rejected before an action confirmation. Denying a valid point does not consume its reference. Approval is followed by another ownership check and the page’s viewport check; a new capture or page change during approval can still reject the point.

Chrome may show its debugging indicator. A visual connection stays on the authorized group page to keep screenshot and point geometry consistent; it never upgrades a manual grant to cross-origin control. Stop control, native debugger cancellation, lost ownership or DSH disconnection withdraws it. Worker restart cleans recorded visual connections without restoring their screenshot refs. Other debuggers or browser policy can prevent capture. The optional `visualViewport` capability keeps wire-v4 text peers compatible; build/restart the Host and reload the extension together.

Run `node scripts/smoke-visual.mjs` for the disposable Host/Chromium canvas check without a model. It checks real image attachment storage, controlled-page pixels while another tab is visible, separate background/text properties, single-use and cross-session refs, scroll/zoom invalidation, same-page design switching with old-point rejection and new-image/property verification, native revocation and cleanup after a worker restart. To also check the existing default model’s separate layer selections and exact metrics, set `STRIDE_REAL_MODEL=1`, with the same optional `STRIDE_MODEL_PATCH` and `STRIDE_MODEL_CREDENTIALS` private inputs described below. That session is limited to ten model requests and twenty browser calls. Only synthetic pages are used; results under `.stride-private/validation/visual/` contain metadata, not real design content. This is not Firefox, Desktop or a real-site acceptance claim.

For native-select model acceptance, add `STRIDE_AUTO_ZOOM=1` to `STRIDE_REAL_MODEL=1`. Also set `STRIDE_LANHU_ZOOM_MENU=1` to use a local synthetic replica of the observed menu, with an isolated hostname mapping and no Lanhu login. That mode holds the prepared menu, stops native control and checks that no selection dispatch occurs before reauthorizing for the model turn. The model must perform the actual zoom change, report the independently observed percentage, take a fresh screenshot and read both layers accurately. Add `STRIDE_AUTO_ZOOM_FALLBACK=1` for a manual request when no usable control exists. Separately, `STRIDE_AUTO_ZOOM_RECOVERY=1` checks a failed dedicated preflight followed by fresh observation, an observed native select, a new screenshot and exact layer reads. These modes allow fourteen model requests and twenty browser calls. Private result files are `auto-zoom.json`, `auto-zoom-fallback.json`, `auto-zoom-recovery.json`, `lanhu-zoom.json` and `lanhu-zoom-fallback.json`. Both updated peers retain optional wire-v4 `designViewZoom`; the intermediate handoff stays inside the extension. Rebuild, restart the Host and reload the extension. Separately, on 2026-11-04 the existing default model changed a real Lanhu toolbar from 27% to 150% in a DSH-created controlled test tab in regular Chrome. Tool text and independent page reads confirmed the percentage; the original tab was unchanged. This real-site check covers the percentage operation and readback only. Synthetic screenshot/layer checks do not establish real-design canvas rendering or full-page fidelity.

Run `STRIDE_REAL_MODEL=1 pnpm run test:smoke-materials` for seven tasks, each with a fresh temporary Host and isolated Chrome: prose requirements, an embedded design within prose, the Wiki page itself as the implementation target, conflicting sources, explicit user precedence, a read-only task with a supplied disposable project, and reuse of an already authorized Wiki while another page is selected. All expose the same browser tools; the model must infer roles from the task. Prose checks business facts; mixed material requires a real screenshot and exact image-only reference facts; the page-target case requires layout measurement matching independent DOM readback. Conflicts must retain both source values and request clarification unless the user has provided precedence. The read-only case additionally exposes scoped file read/write/edit tools, requires a successful project read and checks that no edit was attempted and file bytes stayed unchanged. Only the pure-prose case checks that design tools were unused; this is not a universal Wiki restriction. Reports must match each task’s complete JSON schema, rejecting extra/missing fields while allowing object-key reordering. Use `STRIDE_MATERIAL_CASE=requirements|embedded-design|page-target|conflicting-materials|resolved-materials|read-only-project|reuse-wiki` for a single case. Private evidence is stored under `.stride-private/validation/materials/`; single-case files and the all-case `result.json` record the scope actually run. The disposable-project check does not establish editing or integration in a user-supplied project.

The Host's `browser_read_design_styles` helper organizes readable inspector labels into fixed fields with source evidence, missing values and conflicts. It reuses existing page-read permissions; unsupported layouts still require snapshots, and background/text remain separate reads. The default model has passed separate-layer reads on synthetic pages and the inspected Lanhu interface in regular Chrome after enlarging the view; other layouts need separate acceptance. Restart the Host and reload the extension to preserve inspector line breaks after updating. See [style-field parameters and limitations](../../packages/browser/bridge-browser/README.md#reading-design-style-fields).

For generated DOM pages, `browser_measure_layout` reads actual box distances and computed spacing without modifying the page. Missing/ambiguous selectors fail; unmeasurable aligned gaps remain `null`. It retains page/read-sharing approval and requires both updated peers. This does not measure canvas layers or certify visual fidelity. See [layout measurement](../../packages/browser/bridge-browser/README.md#measuring-rendered-layout).

## Automatically controlling new Chrome pages

For an existing Wiki or other document, the model is instructed to check authorized tabs
and selects the matching page. With both peers updated, `browser_open_tab`
also reuses an authorized matching URL without reloading it; `active: false`
keeps it in the background. Query-key order is normalized, while different
document IDs, query values and URL fragments remain distinct. An ambiguous
match requires a choice, except when the session already controls one match.
Use `newTab: true` only for a separate copy requested by the user or required
by the task. Reuse never grants an unauthorized existing page, and a failed
reuse does not automatically create a replacement. Managed runs still cannot
change their target through these tools.

Enable **Automatically control pages opened by DSH** in settings and save. It is off by default. Ordinary DSH chat can then use `browser_open_tab` to create a tab, authorize that exact native tab, join the control group and bind it to the originating conversation without a toolbar click. Background opens keep the visible page in front. This setting authorizes opening the new page; page reads and later actions still follow the sharing and confirmation settings. Existing tabs and dragged-in group members gain no authority.

The Chrome controller evaluates only packaged DOM operations in a separate isolated world, for the main HTTP(S) document. Cross-site navigation within this new tab remains controlled; child frames and selected-text quotes are not supported by this transport. Closing, moving the tab to another window, leaving the group, **Stop controlling this page**, disabling the setting, unpairing DSH or browser debugger cancellation revokes access. Already-dispatched operations cannot be undone. Automatic grants are not restored after worker/browser restart or extension reload; use a fresh DSH-created page or the toolbar authorization flow. Chrome may show its debugging indicator and can refuse attachment when another debugger or browser policy conflicts.

Preparing the controller does not commit a page write. The original request, target and deadline are checked again immediately before delivery. Evaluations use browser-issued unique context identities so a reused numeric context id cannot select another document after a process change. Restoring manual page grants also requires a native scripting probe: Chrome's tab-metadata permission can expose a URL without granting page access.

If a new page cannot be bound, cleanup first releases that attempt's page grant, then tries to close the tab. A refused close leaves the page unauthorized and is reported as unconfirmed. A user stop or newer toolbar authorization takes ownership away from the old request, so its cleanup cannot revoke that newer grant or close the page.

Firefox does not offer this mode. On Chrome with automatic control saved, a queued `/browser` task can use **Open a new page and start**: enter a complete HTTP(S) URL in its card, then click the button. The Host reserves this startup before any tab is created. The extension creates, authorizes, groups and binds the new tab before starting the Agent. A confirmed pre-start failure cleans up only its own page, respecting native takeover; an uncertain startup reply keeps the page and pin without automatic retry. Managed model calls still cannot create, follow or close tabs. Older Hosts omit this optional capability and keep selected-page startup. `pnpm run test:smoke-browser` exercises ordinary real Host tool dispatch into an automatically controlled synthetic page; it does not call a model or establish DSH Desktop integration. For real-model task startup, see the [Bridge acceptance instructions](../../packages/browser/bridge-browser/README.md#explicit-browser-tasks).

The Host's model guidance uses browser tools for controlled-page tasks, explains how to return observations from `run_code`, and asks the model to stop once the requested page confirmation is observed. It distinguishes a page message from independently verified persistence and discourages shell/network substitution or repeated saves. This guidance does not grant permissions or guarantee model reliability; ordinary chat still does not create a managed task.

### Real-model ordinary-chat check

After building, run `pnpm run test:smoke-auto-tab-model` with `STRIDE_REAL_MODEL=1` to permit real model requests. Optional `STRIDE_MODEL_PATCH` supplies a private DSH configuration patch and `STRIDE_MODEL_CREDENTIALS` supplies an existing credentials file. The script uses the configured temporary Host's default model without selecting another model; copy your default configuration through the private patch when required. Credential copies are restricted to the temporary home and removed at cleanup. Keep both input files out of Git.

This check creates a disposable Host, Chromium profile and synthetic site. It enables automatic control through the extension UI, starts an ordinary Host conversation outside the extension history workspace, and submits a natural-language open/change/save request. No target toolbar grant or initial page binding is performed. Success requires completed model activity, the new tab's conversation binding, sole page grant and blue DSH control group in its original window, debugger access, page confirmation and independently saved server state. The test guard limits this session to twelve model requests and twenty browser calls on the fixture. Metadata-only results are stored under ignored `.stride-private/validation/auto-tab-model/`. They include output lengths and whether the synthetic saved message appeared in browser and `run_code` results, without retaining content. This is one controlled Chrome scenario; Desktop, Firefox and arbitrary sites require separate validation.

The guard rejects non-browser tools for this acceptance session. Any such attempt fails the check even if the site was saved. Record these as model/tool-selection failures; do not treat a passing retry as evidence of reliability.

## Pending page calls

For received page-tool requests, the background captures the selected tab/window and URL before waiting for IndexedDB admission, approval or a write turn. Native navigation/history events invalidate the captured document generation, including same-URL reloads; explicit rebinds, tab replacement/moves and connection replacement invalidate the old binding. A rejected call does not retry itself against a new page. Expired reads are withheld. Already dispatched operations are awaited before later writes; they are not undone or replayed. A committed action may observe its own navigation while its original binding remains valid.

Conversation checkpoints capture a fresh document/binding generation and recheck it after native tab reads. Late reads cannot overwrite a newer checkpoint, even for the same tab id. Deferred follow/open callbacks also check their original connection before changing bindings or conversation hints.

Per-request document fences live in the worker; Host and worker also keep a run/control-revision tab pin. The first eligible managed page call establishes it through confirmation. Later calls cannot follow a rebind, a replacement/move/reused tab id or a new connection, even when the URL is identical. **Continue on selected page** reserves a fresh pin for the new revision before execution. Its selected document must remain current until the first successful execution confirmation. Same-tab navigation then remains supported, with pending calls still fenced on document changes. Managed open/follow/close tools remain unavailable; use the explicit page binding and continuation controls for a paused run. Ordinary unscoped sessions can follow or close only explicitly authorized tabs. Without the Chrome automatic-control opt-in, model-created tabs stay open but remain unbound and unauthorized. Account/tenant identification and automatic reconciliation remain unavailable.

`STRIDE_REAL_MODEL=1 pnpm run test:smoke-worker-view` stops the actual isolated Chrome worker while retaining the same panel document. It verifies the original conversation, successful fresh history read and continued pure chat, with no automatic conversation creation or replay of prompts, selections, approvals or tasks. It uses the existing private default-model configuration and is separate from regular Chrome extension reload acceptance.
