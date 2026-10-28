# Browser extension

English | [中文](README.zh.md)

The Chrome/Firefox extension contains a background bridge client, content scripts for text snapshots and page actions, and a React side panel. It works with the local Bridge in this workspace; it does not install or start a Host by itself.

See the [repository README](../../README.md) for installation, one-time pairing, security and feature status. Chrome and Firefox need separate installation credentials. Page screenshots, CDP input and webpage file transfer are planned, not currently supported.

The Firefox build currently uses a distinct provisional extension ID so it does not replace the upstream extension. A published Firefox release needs its own final ID and migration plan.

## Development

From the repository root:

```sh
pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run typecheck
pnpm --filter dsh-browser-extension run test
```

Chrome output is `extensions/dsh-browser/dist/`; Firefox output is `extensions/dsh-browser/dist-firefox/`. Load the appropriate unpacked build from the browser's extension manager.

The extension requests access to HTTP(S) pages and browser tab/navigation APIs. Page content is untrusted, and state-changing actions require user approval unless the user has explicitly enabled a broader policy. The current target checks reduce stale-element mistakes but do not replace the planned observation-bound action protocol.
