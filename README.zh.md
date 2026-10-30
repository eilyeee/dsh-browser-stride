# DSH Stride（寻行）

[English](README.md) | **中文**

DSH Stride 是 [dsh-browser](https://github.com/omdsh-dev/dsh-browser) 的社区产品分支，通过本机 Bridge 和浏览器侧栏，将 DeepSeek Harness 连接到用户已有的 Chrome 或 Firefox 页面。本项目与 DeepSeek 没有从属或背书关系。

项目目前处于 **M0：兼容性与基线验证**。上游的文本浏览器工具和侧栏聊天可作为开发基线；连接、安装级配对与目标检查已有加固，目前没有正式支持的发行版。

## 环境要求

- Node.js 24 系列中的 24.15 或更高版本；具体支持范围见 `package.json`。
- 使用 `package.json` 的 `packageManager` 指定的 pnpm 版本。
- 现有文本路径需要 Chrome 116+ 或 Firefox 140+；版本满足本身不代表端到端验收通过。
- 兼容的本机 DeepSeek Harness Host。桌面端接入及其实际 profile 仍需验证。

## 从源码运行

检出本仓库后，在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm run build
./scripts/install.sh          # Windows 使用 .\scripts\install.ps1
pnpm start
```

安装脚本会修改本地 DSH 的 **web** profile、构建插件与 Chrome 扩展，并尝试打开 Chrome 扩展管理页；如果该 profile 中存在旧版 Bridge 包，脚本可能移除它，请先阅读脚本。Firefox 需要单独构建和临时安装，详见[扩展说明](extensions/dsh-browser/README.zh.md)。桌面端可能使用其他 profile，安装到 `web` 不等于桌面端已经接通。脚本必须从完整的 Stride 检出目录运行，不会下载上游项目代替本项目。

启动 Host 后，在另一个终端的仓库根目录运行 `pnpm run pair:browser`，将得到的一次性配对码填入已加载扩展的侧栏设置。配对码五分钟后过期，使用后会换成该安装实例专用的凭据。地址可以自动发现；如果 Host 使用非默认端口，运行 `pnpm run pair:browser -- issue --url http://127.0.0.1:PORT`，并在扩展中将 Bridge 地址设为 `ws://127.0.0.1:PORT/ext/bridge`。使用 `pnpm run pair:browser -- list` 查看安装实例，使用 `pnpm run pair:browser -- revoke INSTALLATION_ID` 撤销并断开指定实例；非默认端口也需加上 `--url`。

Host 管理员令牌默认保存在 `$DSH_HOME/ext-bridge-token`，未设置 `DSH_HOME` 时为 `~/.dsh/ext-bridge-token`。请妥善保管，**不要把它填入扩展**。如果 Host 显式配置了令牌，通过 `DSH_BRIDGE_ADMIN_TOKEN` 环境变量传给配对命令。配对期间若保存凭据失败，需要重新生成配对码。

令牌文件在支持的平台使用受限权限，DSH home 还应配置适当的系统访问控制。这无法阻止同一系统账号下的恶意进程读取；当前设计不提供被入侵的本机账号隔离。同一个配对 profile 同时只能由一个 Host 进程使用。

## 当前能力

- 文本快照、绑定观察的控件引用、页面导航、标签管理和划词引用。同一 frame 的新观察会使旧引用失效。
- 通过本机 Harness 会话 API 提供侧栏聊天；聊天图片附件依赖 Host 能力。
- 页面写操作的用户审批、目标执行前检查、单选下拉框选择，以及输入框和复选框状态回读。控件状态回读不能证明表单已经保存。
- 扩展 worker 运行期间的浏览器写操作内存排队；持久动作回执和重启对账仍未实现。
- 仅允许本机回环连接的 Bridge，支持一次性配对码和可单独撤销的安装级凭据。Host 设置、凭据和本地路径操作默认不对 Bridge 开放，只有 Host 显式启用 `allowHostManagement` 后才可使用。

当前不支持网页截图、CDP 输入、网页文件上传下载、可靠任务恢复以及桌面端和侧栏共用的任务模型。点击成功或模型回复不能单独证明业务任务已经完成。

Bridge 和扩展需要从同一次检出构建：点击、输入和单选现在要求最近一次观察给出的 `elementRef`，与旧版裸编号接口不兼容。增量快照只提供本次展示控件的引用；目标未出现时需重新获取完整快照。目前引用还没有绑定任务运行、账号或租户。

连接要求线协议版本 1。缺少版本或版本不兼容时会拒绝连接，侧栏提示需要更新哪一端，并停止自动重试。请从同一次检出重新构建并重启 Host Bridge、重新加载扩展，再打开侧栏。快照预算采用双方提供的较小上限；此握手不代表持久任务运行时已经实现。

## 开发与验证

可信 Host 插件可通过 `ctx.browserRuns` 持久化运行状态与动作事实，支持带版本检查的控制和重启时的状态隔离。浏览器工具现已通过其派发账本记录请求摘要和传输回执；任务生命周期控制、业务结果验证和自动恢复尚未接入工具链路或侧栏。详见 [Bridge 文档](packages/browser/bridge-browser/README.zh.md)。

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
