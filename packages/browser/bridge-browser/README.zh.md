# 浏览器 Bridge

[English](README.md) | 中文

Bridge 在本机 DeepSeek Harness Host 上提供只允许回环访问、需要 token 的 WebSocket，并注册文本形式的 `browser_*` 工具；页面操作由浏览器扩展执行。安装步骤和当前限制见[仓库首页](../../../README.zh.md)。

## 配置

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `token` | 自动生成 | 配对管理令牌；未配置时保存在 `DSH_HOME/ext-bridge-token`，限制文件权限。它不能作为浏览器凭据，不在日志中输出。 |
| `allowHostManagement` | `false` | Host 单独授权设置、凭据及本地路径方法；连接浏览器本身不会授予这些权限。 |
| `pairingProfile` | `web` | 安装级凭据的命名空间，存于 `DSH_HOME/browser-bridge-pairings`；同一命名空间同时只能由一个 Host 进程持有。 |
| `toolTimeoutMs` | `90000` | 单次工具超时，单位毫秒。 |
| `snapshotMaxChars` | `32000` | 快照字符上限，最小 500。 |
| `maxInteractiveItems` | `60` | 单次快照交互元素上限。 |
| `sessionWorkspacePath` | `DSH_HOME/browser-sessions` | 扩展会话的工作区；空字符串关闭分组。 |
| `deferSessionCreate` | `true` | 第一条提示发送时才创建会话。 |

`/ext/bridge-config` 只提供本机 WebSocket 地址。配对管理接口仅限本机，要求单独的管理员令牌并拒绝浏览器 Origin 请求；一次性配对码五分钟后失效，Host 只持久化安装级凭据的哈希。签发、查看和撤销命令见仓库首页。扩展凭据保存在扩展源的 IndexedDB 中，包括无法限制 `storage.local` 访问的 Firefox。

[线协议](src/protocol.ts)与[执行契约类型](src/contracts/)是不同层次；执行契约尚未接入持久任务运行时。请按仓库首页执行检查，并单独验证真实浏览器行为。
