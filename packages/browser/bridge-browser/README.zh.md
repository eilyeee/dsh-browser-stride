# 浏览器 Bridge

[English](README.md) | 中文

Bridge 在本机 DeepSeek Harness Host 上提供只允许回环访问、需要 token 的 WebSocket，并注册文本形式的 `browser_*` 工具；页面操作由浏览器扩展执行。安装步骤和当前限制见[仓库首页](../../../README.zh.md)。

## 配置

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `token` | 自动生成 | 配对管理令牌；未配置时保存在 `DSH_HOME/ext-bridge-token`，限制文件权限。它不能作为浏览器凭据，不在日志中输出。 |
| `allowHostManagement` | `false` | Host 单独授权设置、凭据及本地路径方法；连接浏览器本身不会授予这些权限。 |
| `pairingProfile` | `web` | `DSH_HOME/browser-bridge-pairings` 中安装级凭据及浏览器任务存储域的命名空间；同一存储根目录和命名空间只能由一个 Host 进程持有。 |
| `toolTimeoutMs` | `90000` | 单次工具超时，单位毫秒。 |
| `snapshotMaxChars` | `32000` | 快照字符上限，最小 500。 |
| `maxInteractiveItems` | `60` | 单次快照交互元素上限。 |
| `sessionWorkspacePath` | `DSH_HOME/browser-sessions` | 扩展会话的工作区；空字符串关闭分组。 |
| `deferSessionCreate` | `true` | 第一条提示发送时才创建会话。 |

`/ext/bridge-config` 只提供本机 WebSocket 地址。配对管理接口仅限本机，要求单独的管理员令牌并拒绝浏览器 Origin 请求；一次性配对码五分钟后失效，Host 只持久化安装级凭据的哈希。签发、查看和撤销命令见仓库首页。扩展凭据保存在扩展源的 IndexedDB 中，包括无法限制 `storage.local` 访问的 Firefox。

[线协议](src/protocol.ts)与[执行契约类型](src/contracts/)是不同层次。Host 现通过 `ctx.browserRuns` 向可信插件提供排队任务创建、带版本检查的状态变更、暂停/恢复/停止、不可变动作事实，以及按声明判据检查完成状态。事实必须由可信 Host 代码提供，工具返回的成功文本不能直接作为已验证证据。现有 `browser_*` 工具和侧栏尚未使用此服务。

服务要求 DSH `storageDomain`，存储域名称为 `browser_runs_<pairingProfile 的 UTF-8 十六进制编码>`，使用 Host 配置的存储后端。默认 JSON 后端以私有文件原子写入，不协调共享同一存储根目录的多个 Host 进程。重新打开存储时，未结束的执行上下文会增加控制版本以失效旧指令；运行中记录变为阻塞，停止中记录仍保持停止中。恢复支持实现之前，这类记录不能续跑，也不会重放浏览器动作。目前没有任务记录 RPC 或侧栏删除入口。请按仓库首页执行检查，并单独验证真实浏览器行为。

存储写入失败后，必须重新打开存储域才能继续写入。同一会话存在未对账副作用时，也会阻止其他任务启动。每个任务最多记录 128 项不重复的必需判据和 256 条不可变动作事实。存储状态只是记录，不是浏览器动作的派发许可。
