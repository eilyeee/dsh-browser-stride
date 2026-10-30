# Contributing to DSH Stride

Thanks for helping. This is the product branch (DSH Stride / 寻行) of
[`omdsh-dev/dsh-browser`](https://github.com/omdsh-dev/dsh-browser). Read this
page before opening a substantial pull request; it will save a review cycle.

## Where the project is

The project is at **M0 (compatibility and baseline)**. Security and target
checks have improved; the execution contract is not a complete task runtime.
See the [README](README.md) for current capabilities and limitations.

## Ways to contribute

- **Report a bug** with the issue form. Include the environment block; the
  collector `pnpm run stride:baseline -- --json --no-write` prints it. Review
  and redact machine-specific paths and other identifying details before sharing.
- **Report a security issue** privately — see [`SECURITY.md`](SECURITY.md).
  Never in a public issue.
- **Propose an improvement** in an issue or draft PR, explaining the problem
  and the behavior you intend to change.
- **Improve docs** in Chinese or English; issues and PRs in either are welcome.
- **Add tests** for an invariant that is currently untested. This is the
  cheapest useful contribution in the current phase.

## Development setup

Requirements: Node.js 24.15 or newer in the Node 24 line; use the pnpm version pinned by `packageManager`.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Useful extras:

```sh
pnpm run check:runtime        # dependency/runtime shape check
pnpm run test:smoke           # runtime smoke test
pnpm run stride:baseline      # local M0 environment evidence in .stride-private/
```

The bridge package alone:

```sh
pnpm --filter @eilyeee/dsh-stride-browser-bridge run typecheck
pnpm --filter @eilyeee/dsh-stride-browser-bridge exec vitest run tests/contracts
```

## Ground rules

1. **Contract first.** If a change alters identity, observation, action-outcome,
   run-state, error or capability semantics, change the contract and its tests
   before the caller. The contract lives in
   `packages/browser/bridge-browser/src/contracts/`; read the types and tests.
2. **Support claims with evidence.** Distinguish implemented behavior from
   real-browser and Desktop integration tests. Describe the environment and
   limitations of each verification.
3. **Do not weaken a check to make a test pass.** Stale-reference rejection,
   write serialization, digest checks and capability downgrades are the point of
   this project, not obstacles.

## Tests

- Unit/contract tests run in CI and must be deterministic: no network, no real
  browser, no wall-clock races.
- Real-browser scenarios are recorded as evidence, not added to CI.
- A failing test is closed by fixing it or by explicitly classifying it as
  environment/model/data/unsupported. "It passes on rerun" is not a conclusion.

## Commits and pull requests

- Keep commits small and reviewable; explain *why* in the message.
- Prefixes in use: `feat(scope):`, `fix(scope):`, `docs(scope):`,
  `chore(scope):`.
- Fill in the PR template, including the platform matrix you actually tested.
- Do not reformat unrelated files, do not bump dependencies without a stated
  reason, and do not include generated artifacts (coverage, builds, logs) in a
  commit.

## Data hygiene

Commits, issues and evidence files are public. Before pushing:

- No tokens, cookies, session data, real account details, or personal data.
- No absolute paths from your machine; use `<workspace>/...` or `~/...`.
- Redact page content from screenshots and logs when it contains third-party or
  personal information.
- `pnpm run check:publication` scans the current history, staged content and
  working tree for selected risks. Review any non-GitHub-noreply commit identity
  it reports; a public address is acceptable if its owner intended to publish it.
  This targeted check does not replace a full secret and privacy review.

## License

By contributing you agree that your contribution is licensed under the MIT
license in [`LICENSE`](LICENSE), and that the upstream copyright notice is
preserved. Commit sign-off is not required, and there is no CLA.

## Getting help

Open a discussion-style issue (question form). Please search existing issues
first.

## 中文摘要

- 先看仓库首页，了解当前能力和限制。
- 开发：Node 24.15+ 与 `packageManager` 指定的 pnpm，`pnpm install --frozen-lockfile`、`typecheck`、`test`。
- 契约优先：改语义先改 `src/contracts/` 与测试；不要为让测试通过而放宽校验。
- 区分已实现的行为与真实浏览器、桌面端的验证结果，并说明验证环境。
- 贡献按 MIT 授权，无需提交签署，也没有 CLA。
- 仓库公开：不要提交密钥、真实账号数据、本机绝对路径。
- issue 与 PR 中英文都可以。
