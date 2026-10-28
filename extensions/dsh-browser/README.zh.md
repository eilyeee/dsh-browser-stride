# 浏览器扩展

[English](README.md) | 中文

Chrome/Firefox 扩展包含后台 Bridge 客户端、负责文本快照与页面动作的 content script，以及 React 侧栏。扩展需要配合本工作区的本机 Bridge，不能独立安装或启动 Host。

安装、一次性配对、安全边界和能力状态见[仓库首页](../../README.zh.md)。Chrome 和 Firefox 各自使用安装级凭据。网页截图、CDP 输入及网页文件传输仍在计划中。

Firefox 构建目前使用独立的临时扩展 ID，避免覆盖上游扩展；正式发行前需要确定最终 ID 和迁移方案。

## 开发

在仓库根目录执行：

```sh
pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run typecheck
pnpm --filter dsh-browser-extension run test
```

Chrome 产物位于 `extensions/dsh-browser/dist/`，Firefox 产物位于 `extensions/dsh-browser/dist-firefox/`；在浏览器扩展管理页加载对应的解压产物。

扩展申请 HTTP(S) 页面和标签、导航等权限。页面内容是不可信数据；除非用户明确开启更宽的策略，修改页面的动作需要用户审批。当前目标检查可以减少过期元素误操作，但不能代替计划中的观察版本绑定协议。
