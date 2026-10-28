# NOTICE

DSH Stride（寻行）is a product branch derived from
[`omdsh-dev/dsh-browser`](https://github.com/omdsh-dev/dsh-browser).

- Upstream copyright: Copyright (c) 2026 Yuxiang Lin
- Upstream license: MIT (see [`LICENSE`](LICENSE))
- Baseline commit: `23895d7292495f665e5676d2f174d022bb3c3605`

This repository is distributed under the same MIT license. The upstream
copyright and permission notice in `LICENSE` is retained verbatim; nothing in
this NOTICE adds restrictions to the license.

Stride additions in this branch:

- `packages/browser/bridge-browser/src/contracts/` — execution contract types
  and invariants (not wired into the runtime yet).
- `scripts/stride-baseline.mjs` — M0 environment evidence collector.
- Documentation changes in the root `README.md` / `README.zh.md` marking the
  product branch.

The DSH 0.2.1 Host compatibility work was informed by upstream
[PR 121](https://github.com/omdsh-dev/dsh-browser/pull/121), head
`0115cf755da4c145bb908bc3519ee803ff97e6d1`. The adapter was implemented and
tested in this branch; the rest of that PR and PR 116 were not wholesale
adopted. The fixed upstream commit above is distinct from the sanitized
publication-history ancestor recorded in `docs/stride/baseline/`.
