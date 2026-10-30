# DSH Stride（寻行）

[English](README.md) | **中文**

DSH Stride 是 [dsh-browser](https://github.com/omdsh-dev/dsh-browser) 的社区产品分支，通过本机 Bridge 和浏览器侧栏，将 DeepSeek Harness 连接到用户已有的 Chrome 或 Firefox 页面。本项目与 DeepSeek 没有从属或背书关系。

项目目前处于 **M0：兼容性与基线验证**。上游的文本浏览器工具和侧栏聊天可作为开发基线；连接、安装级配对与目标检查已有加固，目前没有正式支持的发行版。

## 环境要求

- Node.js 24 系列中的 24.15 或更高版本；具体支持范围见 `package.json`。
- 使用 `package.json` 的 `packageManager` 指定的 pnpm 版本。
- 现有文本路径需要 Chrome 116+ 或 Firefox 140+；版本满足本身不代表端到端验收通过。
- 本机 DeepSeek Harness Host 与项目 DSH 依赖统一使用 `0.2.1-rc.5`；只更新全局 CLI 会造成版本不匹配。桌面端接入及其实际 profile 仍需验证。

## 从源码运行

检出本仓库后，在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm run build
./scripts/install.sh          # Windows 使用 .\scripts\install.ps1
pnpm start
```

安装脚本会修改本地 DSH 的 **web** profile、构建插件与 Chrome 扩展，并尝试打开 Chrome 扩展管理页；如果该 profile 中存在旧版 Bridge 包，脚本可能移除它，请先阅读脚本。Firefox 需要单独构建和临时安装，详见[扩展说明](extensions/dsh-browser/README.zh.md)。桌面端可能使用其他 profile，安装到 `web` 不等于桌面端已经接通。脚本必须从完整的 Stride 检出目录运行，不会下载上游项目代替本项目。

启动 Host 后，在扩展侧栏设置中点击「连接本机 DSH」。保持侧栏打开，在已登录的 DSH 网页「设置 → 通用 → 浏览器配对」中核对相同校验码并确认，扩展会自动保存安装级凭据并连接，以后自动重连。请求五分钟后过期；拒绝、取消或 Host 重启后需要重新发起。请求本身不授予权限，只有经过 Host 登录认证的用户才能确认；凭据只交给持有本次请求证明的扩展，不放入网页、URL 或日志。连接成功会替换当前浏览器连接，页面操作仍遵循扩展审批策略。

也可在另一个终端的仓库根目录运行 `pnpm run pair:browser`，将一次性配对码填入扩展设置。配对码五分钟后过期，使用后换成安装级凭据。地址可以自动发现；非默认端口可在扩展中填写 `ws://127.0.0.1:PORT/ext/bridge`，手动配对命令加上 `-- issue --url http://127.0.0.1:PORT`。使用 `pnpm run pair:browser -- list` 查看安装实例，使用 `pnpm run pair:browser -- revoke INSTALLATION_ID` 撤销并断开指定实例，同时取消它尚未领取的配对请求；非默认端口也需加上 `--url`。

### 更新

当前使用源码安装：在原检出目录拉取更新，用项目要求的 Node/pnpm 安装锁定依赖并运行 `pnpm build`，重启 Host，在 `chrome://extensions/` 点击扩展的「重新加载」，再刷新需要操作的网页。保留原扩展安装、相同浏览器配置和 Host 数据即可沿用配对；更换扩展安装身份或清除数据后需要重新配对。Firefox 临时扩展需重新载入。Bridge 和扩展应来自同一检出，不兼容时会提示更新哪一端。

DSH 能安装 GitHub 插件，但本仓库根目录目前是开发工作区，尚未提供可直接通过 GitHub 插件入口安装的发布包，也没有浏览器商店自动更新渠道。GitHub 安装 Host 插件不会替浏览器安装或更新扩展。

Host 管理员令牌默认保存在 `$DSH_HOME/ext-bridge-token`，未设置 `DSH_HOME` 时为 `~/.dsh/ext-bridge-token`。请妥善保管，**不要把它填入扩展**。如果 Host 显式配置了令牌，通过 `DSH_BRIDGE_ADMIN_TOKEN` 环境变量传给配对命令。配对期间若保存凭据失败，需要重新生成配对码。

令牌文件在支持的平台使用受限权限，DSH home 还应配置适当的系统访问控制。这无法阻止同一系统账号下的恶意进程读取；当前设计不提供被入侵的本机账号隔离。同一个配对 profile 同时只能由一个 Host 进程使用。

## 当前能力

- 文本快照、绑定观察的控件引用、页面导航、标签管理和划词引用。同一 frame 的新观察会使旧引用失效。
- 通过本机 Harness 会话 API 提供侧栏聊天；聊天图片附件依赖 Host 能力。
- 页面写操作的用户审批、目标执行前检查、单选下拉框选择，以及输入框和复选框状态回读。控件状态回读不能证明表单已经保存。
- 扩展 worker 运行期间的浏览器写操作内存排队、Host 派发元数据和扩展持久执行占位；任务恢复和业务结果对账仍未实现。
- 仅允许本机回环连接的 Bridge，支持一次性配对码和可单独撤销的安装级凭据。Host 设置、凭据和本地路径操作默认不对 Bridge 开放，只有 Host 显式启用 `allowHostManagement` 后才可使用。

当前不支持网页截图、CDP 输入、网页文件上传下载、可靠任务恢复以及桌面端和侧栏共用的任务模型。点击成功或模型回复不能单独证明业务任务已经完成。

Bridge 和扩展需要从同一次检出构建：点击、输入和单选现在要求最近一次观察给出的 `elementRef`，与旧版裸编号接口不兼容。增量快照只提供本次展示控件的引用；目标未出现时需重新获取完整快照。目前引用还没有绑定任务运行、账号或租户。

连接要求线协议版本 2，工具调用与回复必须携带 Host 签发的动作 ID 和命令摘要。缺少版本或版本不兼容时会拒绝连接，侧栏提示需要更新哪一端，并停止自动重试。请从同一次检出重新构建并重启 Host Bridge、重新加载扩展，再打开侧栏。快照预算采用双方提供的较小上限。扩展在派发前提交持久执行占位，worker 重启后仍拒绝重复 ID；这不代表完整任务运行时或自动恢复已经实现。

## 开发与验证

可信 Host 插件可通过 `ctx.browserRuns` 持久化运行状态与动作事实，并用 `withExecution` 将浏览器调用绑定到运行和控制版本。暂停、停止和控制版本变化会撤销旧执行上下文；账本记录所属运行与传输回执。任务创建和控制尚未接入侧栏，业务结果验证、扩展端完整运行/目标绑定和自动恢复仍未实现。详见 [Bridge 文档](packages/browser/bridge-browser/README.zh.md)。

```sh
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run check:runtime
pnpm run test:smoke
pnpm run test:benchmark
```

构建后可选运行 `pnpm run test:smoke-browser`，使用临时 profile 在本地合成页面上检查真实 Host 与 Chromium 扩展；该测试不调用模型。运行时 smoke 也使用隔离的临时 DSH home；桌面端和真实站点场景需要另行验收。另见[贡献指南](CONTRIBUTING.md)、[安全政策](SECURITY.md)和[基准测试方法](benchmark/README.md)。

本仓库保留上游 MIT 许可证及来源声明：[LICENSE](LICENSE)、[NOTICE.md](NOTICE.md)。
