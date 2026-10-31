# 浏览器扩展

[English](README.md) | 中文

Chrome/Firefox 扩展包含后台 Bridge 客户端、负责文本快照与页面动作的 content script，以及 React 侧栏。扩展需要配合本工作区的本机 Bridge，不能独立安装或启动 Host。

安装、一次性配对、安全边界和能力状态见[仓库首页](../../README.zh.md)。Chrome 和 Firefox 各自使用安装级凭据。当前不支持网页截图、CDP 输入及网页文件传输。

Firefox 构建目前使用独立于上游扩展的临时扩展 ID，尚未作为 Firefox 扩展正式发布。

线协议 v2 要求配套的 Host 构建。命令携带动作 ID 和摘要，检查通过后先由扩展源 IndexedDB 事务提交执行占位。同一 ID 在占位保留期间只执行一次，worker 重启后仍有效；命令变化会被拒绝。存储只包含身份、时间戳及接纳/结束阶段，不缓存页面、输入原文或历史结果正文。最多保留 5,000 条占位，不自动过期或淘汰；存储不可用或已满时阻止新执行，损坏的已有占位会阻止对应动作。清除浏览器或扩展数据会移除这层保护。占位不代替用户授权、实时目标检查和业务结果验证，也不提供自动恢复或重放。

## 开发

在仓库根目录执行：

```sh
pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run typecheck
pnpm --filter dsh-browser-extension run test
```

Chrome 产物位于 `extensions/dsh-browser/dist/`，Firefox 产物位于 `extensions/dsh-browser/dist-firefox/`。仓库安装脚本会配置 `web` Host profile 并准备 Chrome 扩展。使用 Firefox 时，还需执行上面的 Firefox 构建命令，在 Firefox 打开 `about:debugging`，选择“此 Firefox”→“临时载入附加组件”，然后选择 `extensions/dsh-browser/dist-firefox/manifest.json`。这是临时安装，Firefox 重启后需要重新载入；详见 [Mozilla 临时安装说明](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/)。按仓库首页的步骤为 Firefox 扩展单独配对。

扩展申请 HTTP(S) 页面和标签、导航等权限。页面内容是不可信数据；除非用户明确开启更宽的策略，修改页面的动作需要用户审批。点击、输入和选择需要最近一次观察给出的元素引用；目前引用尚未绑定任务运行、账号或租户。

侧栏显示当前会话中由 Host 创建的浏览器运行，并提供暂停和停止按钮。停止请求会保持「停止中」，直到执行器确认。普通聊天不会自动创建运行，任务创建和恢复仍由可信 Host 负责，自动对账尚未实现。控制要求真实用户操作，携带所显示的记录版本，且不自动重试。

## 等待中的页面调用

收到操作页面的工具请求时，后台会在等待 IndexedDB 执行占位、审批或写入顺序之前固定已选标签页、窗口和 URL。浏览器导航与历史事件会使旧文档代次失效，包括相同 URL 的重新加载；重新绑定、标签页替换或移动、连接更换也会使旧绑定失效。被拒绝的调用不会自行改到新页面重试，已过期的读取结果不会返回。已经派发的操作仍须先结束，后续写入才能开始；它们不会被撤销或重放。已派发的动作可以在原绑定仍有效时观察自己引起的导航。

会话恢复检查点会重新固定文档与绑定代次，并在浏览器返回标签页读取结果后再次检查。即使标签页 ID 相同，晚到的读取也不能覆盖新的检查点。延迟完成的跟随或新建标签回调，在修改绑定或会话提示前也会检查原连接是否仍有效。

这些检查只存在于 worker 内，跨 worker 重启的防重放仍由原有持久动作身份负责。浏览器级标签页创建/管理和内部交接刷新继续使用各自的审批路径。扩展端完整运行/控制授权、账号或租户绑定以及自动对账仍未实现。
