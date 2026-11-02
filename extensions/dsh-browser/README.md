# Browser extension

English | [中文](README.zh.md)

The Chrome/Firefox extension contains a background bridge client, content scripts for text snapshots and page actions, and a React side panel. It works with the local Bridge in this workspace; it does not install or start a Host by itself.

See the [repository README](../../README.md) for installation, one-time pairing, security and feature status. Chrome and Firefox need separate installation credentials. Page screenshots, CDP input and webpage file transfer are not currently supported.

The Firefox build uses a provisional extension ID distinct from the upstream extension. It is not a published Firefox release.

Wire protocol v4 requires the matching Host build. Commands carry an action id, a digest and an explicit legacy/run scope. The digest is checked before an extension-origin IndexedDB transaction commits an execution fence. After admission and any write turn, the extension confirms the original pending request with the same Host connection; a copied run id or late reply cannot renew authority. Browser permissions still apply. The same id is never executed twice while its fence is retained, including after worker restart; changed commands are refused. Only identity, timestamps and admission/finish phase are stored. Page/input text and previous result payloads are not cached. The store holds up to 5,000 fences with no automatic expiry or eviction; Unavailable or full storage blocks new execution; a corrupt existing fence blocks its action. Clearing browser/extension data removes this protection. These fences do not replace user permission, live target checks or business-result verification, and there is no automatic recovery/replay.

## Development

From the repository root:

```sh
pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run typecheck
pnpm --filter dsh-browser-extension run test
```

Chrome output is `extensions/dsh-browser/dist/`; Firefox output is `extensions/dsh-browser/dist-firefox/`. The repository installer prepares the `web` Host profile and Chrome extension. For Firefox, also run the Firefox build above, open `about:debugging`, select **This Firefox** → **Load Temporary Add-on**, and choose `extensions/dsh-browser/dist-firefox/manifest.json`. This installation lasts until Firefox restarts; see [Mozilla's temporary installation instructions](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/). Pair the Firefox installation separately using the root README's instructions.

The extension no longer requests persistent access to all websites, tab-history permissions or automatic content-script injection. The remaining `http://127.0.0.1/*` host permission is for local DSH communication; model access to a loopback page still requires explicit authorization of that tab. Page content is untrusted, and state-changing actions follow the approval settings. Click, type and select require an element reference from the latest observation; these references are not yet bound to a task run, account or tenant.

The side panel shows metadata for Host-created browser runs in the current conversation, with explicit Pause and Stop controls. A stop request remains Stopping until its executor confirms. For a paused run with settled writes and no recovery requirement, bind the intended page using the control above the conversation, then click **Continue on selected page**. This selects the current native page and advances the run's control revision; it does not revive old execution contexts. The executor must pick up the updated run in a fresh context. DSH Web's `/browser <goal>` command creates an explicit waiting task. Select that conversation in the history picker, select the intended browser page and click **Bind and start**. This real user action revalidates and binds the native page before the Host starts its Agent; reading history or reconnecting does not start it. Waiting tasks stay selectable even before their first model turn. Ordinary chat does not automatically create tasks, and automatic reconciliation is not implemented. Controls require real user input, carry the displayed record version and are never automatically retried. Hosts without the optional `canRetarget` capability do not show the continuation button.

Use **Unpair DSH** in extension settings to disconnect this browser. It removes the local credential and disables automatic reconnection across panel, worker and browser restarts. When the Host is reachable, it also revokes this installation’s credential and cancels its outstanding pairing requests. If the Host cannot confirm revocation, the UI reports local removal only. Pages and conversations stay open; reconnecting requires explicit pairing.

## Authorizing one page

Open the intended page and click the **DSH Stride toolbar icon**, then select the task and choose **Bind and start** in the side panel. Opening the sidebar through the browser menu, clicking a sidebar button or sending model instructions cannot grant page access. Same-site sibling tabs require their own toolbar click.

Authorized tabs join the blue **DSH 控制** group, managed separately in each window. Dragging an unapproved tab into the group grants no access and removes that tab from the group. Dragging an authorized tab out or choosing **Stop controlling this page** revokes Stride control. Pinned tabs and browsers without grouping support keep the same permission restrictions without a visible group. Stopping does not undo already-dispatched effects or remove DSH pairing. The browser's temporary permission expires on navigation or closing; the stop button immediately revokes Stride authorization and deactivates the page script.

Cross-site navigation, closing a tab, extension reloads and browser restarts require another toolbar click. Chrome retains temporary access across same-origin reloads; Firefox requires authorization after a new document loads. Page grants are not restored after browser restart, and group membership is never authority. Cross-origin iframe content is outside the temporary grant; when injection is unavailable, only the accessible main document is handled. See [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab) and [Firefox activeTab](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/activeTab_permission).

Run `pnpm run test:smoke-page-access` to check page permissions and grouping with a disposable Chromium profile and synthetic local sites. It calls no model and uses no daily browser profile. This check needs Chrome for Testing with `Extensions.triggerAction` support.

## Pending page calls

For received page-tool requests, the background captures the selected tab/window and URL before waiting for IndexedDB admission, approval or a write turn. Native navigation/history events invalidate the captured document generation, including same-URL reloads; explicit rebinds, tab replacement/moves and connection replacement invalidate the old binding. A rejected call does not retry itself against a new page. Expired reads are withheld. Already dispatched operations are awaited before later writes; they are not undone or replayed. A committed action may observe its own navigation while its original binding remains valid.

Conversation checkpoints capture a fresh document/binding generation and recheck it after native tab reads. Late reads cannot overwrite a newer checkpoint, even for the same tab id. Deferred follow/open callbacks also check their original connection before changing bindings or conversation hints.

Per-request document fences live in the worker; Host and worker also keep a run/control-revision tab pin. The first eligible managed page call establishes it through confirmation. Later calls cannot follow a rebind, a replacement/move/reused tab id or a new connection, even when the URL is identical. **Continue on selected page** reserves a fresh pin for the new revision before execution. Its selected document must remain current until the first successful execution confirmation. Same-tab navigation then remains supported, with pending calls still fenced on document changes. Managed open/follow/close tools remain unavailable; use the explicit page binding and continuation controls for a paused run. Ordinary unscoped sessions can follow or close only explicitly authorized tabs. Model-created tabs stay open but remain unbound and unauthorized. Account/tenant identification and automatic reconciliation remain unavailable.
