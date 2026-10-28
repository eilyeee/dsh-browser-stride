# 浏览器扩展

[English](README.md) | 中文

Chrome/Firefox 扩展包含后台 Bridge 客户端、负责文本快照与页面动作的 content script，以及 React 侧栏。扩展需要配合本工作区的本机 Bridge，不能独立安装或启动 Host。

安装、一次性配对、安全边界和能力状态见[仓库首页](../../README.zh.md)。Chrome 和 Firefox 各自使用安装级凭据。当前不支持网页截图、CDP 输入及网页文件传输。

Firefox 构建目前使用独立于上游扩展的临时扩展 ID，尚未作为 Firefox 扩展正式发布。

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
