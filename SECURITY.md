# Security policy

DSH Stride drives a browser that holds your logged-in sessions. A bug here can
act with your cookies, so security reports are handled privately and before
anything else.

## Reporting a vulnerability

Use **GitHub private vulnerability reporting** on this repository when it is
enabled (Security → Report a vulnerability). Do **not** disclose vulnerability
details in a public issue.

If private reporting is unavailable, use the public Question issue form only
to request a private contact channel. Include no technical details; for example,
write "security report — please provide a private channel".

Please do not include real credentials, cookies, session tokens, browser
profiles, or third-party personal data in any report. A redacted reproduction is
more useful than a full dump.

## In scope

- Bridge authentication, pairing, token storage, and the loopback-only rule.
- Extension permissions, content-script isolation, and message validation
  between extension layers.
- The page-content trust boundary: page text, titles, URLs and selections must
  never become instructions or authorization.
- Approval and target checks for supported browser actions and Host management.
- Exposure of sensitive data in page snapshots, logs and credentials.
- Supply-chain issues introduced by this branch (dependencies, candidate
  patches, build scripts).

## Out of scope

- Vulnerabilities in Chrome, DeepSeek Harness, or upstream `dsh-browser` that
  are not caused by changes in this branch. Report those upstream; we will
  relay if the fix needs to land here too.
- Social engineering, physical access, and attacks requiring an already
  compromised host or browser profile.
- Automated scanning against third-party web sites. Do not test on sites you do
  not own or have permission to use.

## Supported versions

There is **no supported release yet**. The project is at M0 (compatibility and
baseline) and only the latest development state is maintained. Fixes are not
backported to upstream commits or to any pre-release build.

## What to expect

- Acknowledgement on a best-effort basis, normally within 7 days.
- A coordinated disclosure: we will agree on a date with you and credit you
  unless you prefer to stay anonymous.
- No bug bounty and no payment. This is a community project.

## Safe harbor

We will not pursue legal action for good-faith research that follows this
policy: do not access other people's data, do not degrade service for others,
do not run denial-of-service tests, and give us reasonable time to fix before
disclosing.

## 中文摘要

安全漏洞请通过 GitHub 的私密漏洞报告提交，**不要**在公开 issue 中披露漏洞详情。如果私密报告入口不可用，可以通过公开的 Question 表单仅请求私密联系方式，不要填写技术细节。报告里不要放真实凭据、Cookie、会话令牌、浏览器 profile 或他人个人数据。当前没有正式发布版本，只维护最新开发状态；不提供赏金。善意研究按本政策进行不会被追责。
