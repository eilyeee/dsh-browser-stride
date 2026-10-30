# Browser extension

English | [中文](README.zh.md)

The Chrome/Firefox extension contains a background bridge client, content scripts for text snapshots and page actions, and a React side panel. It works with the local Bridge in this workspace; it does not install or start a Host by itself.

See the [repository README](../../README.md) for installation, one-time pairing, security and feature status. Chrome and Firefox need separate installation credentials. Page screenshots, CDP input and webpage file transfer are not currently supported.

The Firefox build uses a provisional extension ID distinct from the upstream extension. It is not a published Firefox release.

Wire protocol v2 requires the matching Host build. Commands carry an action id and digest, checked before an extension-origin IndexedDB transaction commits an execution fence. The same id is never executed twice while its fence is retained, including after worker restart; changed commands are refused. Only identity, timestamps and admission/finish phase are stored. Page/input text and previous result payloads are not cached. The store holds up to 5,000 fences with no automatic expiry or eviction; Unavailable or full storage blocks new execution; a corrupt existing fence blocks its action. Clearing browser/extension data removes this protection. These fences do not replace user permission, live target checks or business-result verification, and there is no automatic recovery/replay.

## Development

From the repository root:

```sh
pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run typecheck
pnpm --filter dsh-browser-extension run test
```

Chrome output is `extensions/dsh-browser/dist/`; Firefox output is `extensions/dsh-browser/dist-firefox/`. The repository installer prepares the `web` Host profile and Chrome extension. For Firefox, also run the Firefox build above, open `about:debugging`, select **This Firefox** → **Load Temporary Add-on**, and choose `extensions/dsh-browser/dist-firefox/manifest.json`. This installation lasts until Firefox restarts; see [Mozilla's temporary installation instructions](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/). Pair the Firefox installation separately using the root README's instructions.

The extension requests access to HTTP(S) pages and browser tab/navigation APIs. Page content is untrusted, and state-changing actions require user approval unless the user has explicitly enabled a broader policy. Click, type and select require an element reference from the latest observation; these references are not yet bound to a task run, account or tenant.
