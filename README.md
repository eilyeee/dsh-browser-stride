# DSH Stride (寻行)

**English** | [中文](README.zh.md)

DSH Stride is a community product branch of [dsh-browser](https://github.com/omdsh-dev/dsh-browser). It connects DeepSeek Harness to a user's existing Chrome or Firefox tabs through a local bridge and a browser side panel. It is not affiliated with or endorsed by DeepSeek.

The project is in **M0: compatibility and baseline verification**. The upstream text-based browser tools and side-panel chat are available as a development baseline. Connection, installation pairing and target checks have been hardened. There is no supported release yet.

## Requirements

- Node.js 24.15 or later in the supported Node 24 line; the exact supported range is in `package.json`.
- The pnpm version specified by `packageManager` in `package.json`.
- Chrome 116+ or Firefox 140+ for the existing text path. A browser version alone does not establish end-to-end support.
- A compatible local DeepSeek Harness Host. Desktop integration and the active profile still require verification.

## Run from source

After checking out this repository:

```sh
pnpm install --frozen-lockfile
pnpm run build
./scripts/install.sh          # Windows: .\scripts\install.ps1
pnpm start
```

The installer modifies the local **web** DSH profile, builds the plugin and Chrome extension, and attempts to open Chrome's extension page. It may remove the legacy bridge package from that profile; review the script before running it. Firefox requires a separate build and temporary installation; see the [extension README](extensions/dsh-browser/README.md). Desktop may use a different profile, so installation into `web` is not proof of Desktop integration. The installer must be run from a complete Stride checkout; it does not download an upstream project.

After starting the Host, run `pnpm run pair:browser` in another terminal, then enter the one-time code in the unpacked extension's side-panel settings. The code expires after five minutes and is replaced by an installation-specific credential. The address can be discovered automatically. For a nondefault port use `pnpm run pair:browser -- issue --url http://127.0.0.1:PORT` and set the bridge address to `ws://127.0.0.1:PORT/ext/bridge`. Run `pnpm run pair:browser -- list` to see installations and `pnpm run pair:browser -- revoke INSTALLATION_ID` to revoke one and disconnect it. Add the same `--url` when needed.

The Host's administrator token is stored at `$DSH_HOME/ext-bridge-token`, or `~/.dsh/ext-bridge-token` when `DSH_HOME` is unset. Keep it private and do not enter it in the extension. If a Host was configured with an explicit token, provide it to the CLI via `DSH_BRIDGE_ADMIN_TOKEN`. If credential storage fails during pairing, issue a new code.

The token file uses restrictive permissions where supported; protect the DSH home with appropriate operating-system access controls. These do not stop malicious processes running as the same user, and the current design does not claim isolation from a compromised local account. Use only one Host process per pairing profile.

## What exists today

- Text snapshots, observation-bound control references, page navigation, tab management and selected-text quoting. A new observation invalidates earlier references in that frame.
- A side-panel conversation connected to the local Harness session API; chat image attachments depend on Host support.
- User approval for page-changing actions, target checks, single-select options, and input/checkbox readback. Control readback does not prove a form was saved.
- In-memory ordering for browser writes while the extension worker is alive; durable action receipts and restart reconciliation are not implemented.
- A loopback-only bridge with one-time pairing and separately revocable installation credentials. Host settings, credentials and local-path operations are disabled over the bridge unless the Host explicitly opts in with `allowHostManagement`.

Screenshots, CDP input, webpage uploads/downloads, reliable run recovery and a shared Desktop/side-panel task model are not currently supported. A successful click or model response is not independent proof that a business task completed.

Build the Bridge and extension from the same checkout: click, type and select now require an `elementRef` from the latest observation. Earlier bare-index clients are incompatible. A delta only provides references for controls it shows; take a full snapshot when a target is missing. References do not yet bind a task run, account or tenant.

Connections require wire protocol version 2, including Host-issued action ids and command digests on tool calls and replies. Missing or incompatible versions are rejected; the side panel identifies which component needs updating and stops automatic retries. Rebuild and restart the Host Bridge and reload the extension together, then reopen the panel. Snapshot budgets use the smaller limit offered by the two components. The extension commits a persistent execution fence before dispatch and refuses repeated ids across worker restart. This does not establish a complete task runtime or automatic recovery.

## Development

Trusted Host plugins can persist run state and action facts through `ctx.browserRuns`, with version-checked controls and restart fencing. Browser tools now record request digests and transport receipts through its dispatch ledger; task lifecycle controls, business-result verification and automatic recovery are not yet connected to the tool path or side panel. See the [Bridge documentation](packages/browser/bridge-browser/README.md).

```sh
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run check:runtime
pnpm run test:smoke
pnpm run test:benchmark
```

After building, `pnpm run test:smoke-browser` optionally checks the real Host and a Chromium extension against a synthetic local page, using temporary profiles. It does not call a model. The runtime smoke also uses an isolated temporary DSH home; Desktop and real-site scenarios need separate evidence. See [contributing](CONTRIBUTING.md), [security](SECURITY.md), and [benchmark methodology](benchmark/README.md).

The repository retains the upstream MIT license and attribution in [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
