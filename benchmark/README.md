# DSH Browser Benchmark

这个目录提供一个可重复的端到端评测，用同一个 DSH web profile、模型、任务和本机 Chromium，对比两种浏览器执行后端：

- `playwright`：runner 内置的 Playwright 基线插件，向模型暴露与产品一致的 `browser_*` 工具契约。
- `extension`：本仓库真实的 DSH browser bridge + Chrome MV3 扩展。

评测目标是比较“模型收到同一个任务后，到 DSH turn 完整结束”的真实耗时和成功率。它不是只测一次 `click()` 的微基准。

## 快速开始

先从仓库根目录安装与 lockfile 中 `playwright-core` 匹配的 Chrome for Testing、构建当前代码并检查运行矩阵：

```bash
pnpm --dir benchmark install-browser
pnpm build
node benchmark/run.mjs --dry-run --smoke
```

扩展自动加载需要 Chrome for Testing 或 Chromium。新版 Google Chrome Stable 会忽略 `--load-extension`，不能作为扩展后端的自动评测浏览器。

不调用模型的全链路基础设施探针：

```bash
pnpm --dir benchmark probe
```

仓库还提供使用临时 DSH home、真实 Host 工具运行时和合成页面的独立浏览器 smoke：

```bash
pnpm run test:smoke-browser
```

它不调用模型，也不验证真实目标站点。还会检查扩展对缺少版本或版本不兼容的 Host 显示升级提示、停止重连，并拒绝该连接发来的页面操作。先构建 bridge 和 Chrome 扩展；必要时通过 `PLAYWRIGHT_CHROMIUM_PATH` 指定支持加载扩展的 Chromium。

真实 smoke 会调用当前 DSH profile 配置的模型，因此会消耗模型额度：

```bash
node benchmark/run.mjs --smoke
```

当前结果校验要求顶层工具调用名以 `browser_` 开头。DSH 的 PTC preset 使用顶层 `run_code`，即使其中只调用浏览器工具也会被判为失败；使用 `standard` 等原生工具 preset 后再运行。禁止其他工具目前依靠提示词和事后结果校验，不构成执行时权限隔离；评测须在受控环境中进行。

正式运行默认执行 6 个任务 × 5 个 seed × 2 个后端，共 60 次：

```bash
node benchmark/run.mjs
```

常用参数：

```bash
node benchmark/run.mjs \
  --tasks order_lookup,contact_form,cart_checkout \
  --seeds 1-5 \
  --trials 2 \
  --timeout-ms 120000
```

如需固定模型，两边会对各自 session 应用同一选择：

```bash
node benchmark/run.mjs --provider <provider-id> --model <model-id> --reasoning-effort <effort-id>
```

结果逐行写入 `results/<timestamp>.jsonl`，结束后自动生成对应的 `.report.md`。也可以重新生成最近一份报告：

```bash
node benchmark/report.mjs
node benchmark/report.mjs benchmark/results/<file>.jsonl
```

`--output` 必须指向一个尚不存在的新文件；runner 会拒绝向旧 JSONL 追加另一轮 benchmark，避免不同套件版本、模型或环境被静默汇总。报告生成器也会拒绝聚合包含多个 `benchmarkSuiteVersion` 的 JSONL。需要合并分析时应保留各自文件，并显式按套件版本和配置分组后分别生成报告。

## 任务集

任务全部运行在 `127.0.0.1` 上的确定性网页中，不依赖外网数据：

| 任务 | 类型 | 验证方式 |
| --- | --- | --- |
| `order_lookup` | 读取 | 最终回答包含 seed 对应金额 |
| `notification_toggle` | 单步写操作 | 服务端状态确认已开启并保存 |
| `contact_form` | 表单 | 服务端状态确认三个字段和提交动作 |
| `inventory_filter` | 筛选 + 读取 | 服务端确认筛选值，回答确认唯一商品 |
| `cart_checkout` | 多步操作 | 服务端确认商品、数量和结算 |
| `lazy_load` | 动态内容 | 服务端确认加载动作，回答确认新代码 |

每个任务的可见数据随 seed 确定性变化，降低模型记住固定答案的可能。网页状态通过独立 HTTP API 验证，不依据模型自报“已完成”。

当前评测套件版本为 `4`：文本观察加入校验状态，按键工具明确使用合成事件，不再伪造表单提交；不能与版本 `3` 或更早结果直接汇总。版本 `3` 引入观察绑定引用和单选工具；版本 `2` 修正了 `inventory_filter` 的目标商品名。以后只要任务提示、模型可见接口、数据生成或 validator 语义变化，都必须递增版本。

## 公平性控制

- 两边共享同一提示词、任务实例、DSH profile、模型选择、浏览器尺寸、locale 和时区。
- Playwright 适配器与扩展的共同基础工具使用相同的名称、参数和主要说明，并共享浏览器策略提示；按键工具两边都只发送合成事件。Playwright 只支持顶层 frame，其他观察、动作与权限实现并不相同，也不提供扩展的全部标签管理工具。比较结果要连同这些差异一起解释，不能作为扩展安全或多 frame 能力的验收证据。
- 两个 DSH 进程使用隔离的 session/storage 目录，避免相互污染；模型凭据仍来自同一个本机 DSH profile。
- 扩展后端使用临时 Host 管理凭据签发一次性配对码；扩展只接收配对码和安装级凭据，不接收 Host 管理凭据。
- 同任务、同 seed 形成一个 pair，谁先运行由确定性哈希交替，降低固定顺序导致的热身偏差。
- 提示词禁止非 `browser_*` 工具，validator 也会把使用其他工具的运行判为失败。
- 两边都使用当前仓库构建产物；正式评测前必须先执行 `pnpm build`。

## 指标定义

- `success`：网页外部状态和/或最终答案通过任务 validator，未使用禁用工具，并以 `turn/end: completed` 结束。
- `timings.completionMs`：调用 `session.prompt` 前到收到对应 `turn/end` 的端到端耗时，是报告的主指标。
- `timings.stateReachedMs`：写操作首次在独立网页状态 API 中达到目标的时间，50ms 轮询精度。
- `timings.ttftMs`：从主计时起点到第一个非空模型 stream delta。
- `timings.toolWallMs`：runner 从 `tool/call` 到匹配 `tool/result` 观察到的工具耗时之和。
- `tokens`：该 turn 中所有 assistant step 报告的 token 总和。报告将新输入、缓存读取、缓存写入和输出分列；总览中的 `prompt token` 是前三项之和，不再笼统称为“输入 token”。

报告只对成功运行计算常规延迟，并始终并列展示成功率。少于 10 个成功样本时不展示 P90，避免小样本的虚假精度。配对表会分别列出双方成功、仅一方成功和双方失败，并另提供失败惩罚指标：失败样本按 `2 × timeout` 计时，避免一个后端通过快速失败得到看似更低的耗时。

## 解释边界

这是完整浏览器后端的端到端比较，不是纯 WebSocket 或进程内调用的传输微基准。虽然模型可见工具契约已经对齐，两边的页面结构化表示、元素索引和动作执行实现仍然不同；这些差异会影响模型调用次数、token 和成功率，也正是被测后端的一部分。因此，报告中的速度比不能被表述为“扩展传输本身的开销”。

模型服务端延迟也无法由本地 runner 隔离。正式结论必须同时看成功率、配对结果、失败惩罚比、运行顺序敏感性和置信区间，而不是只比较一次 P50。

## 建议的正式流程

1. 关闭会争抢 CPU 的应用，固定网络环境和 DSH/model 配置。
2. 先跑 `--smoke`，确认两边都成功，不要把基础设施故障混入正式数据。
3. 至少使用默认 5 个 seed；结果噪声大时增加 `--trials`。
4. 先比较成功率，再看成功配对的耗时比和 95% bootstrap 置信区间。
5. 保留原始 JSONL。报告可以重算，原始事件摘要和失败诊断更适合定位异常。`diagnostics.eventTypeRuns` 使用无损连续事件计数，按 `{ type, count }` 展开即可还原完整事件顺序。

## 目录结构

```text
benchmark/
  lib/                    runner、DSH client、统计与任务定义
  patches/                两个隔离 DSH backend 的 profile patch
  plugin/                 Playwright 基线的 browser_* 插件
  site/                   本地确定性任务站
  tests/                  不调用模型的单元/集成测试
  results/                原始 JSONL 和 Markdown 报告（默认 gitignore）
  run.mjs                 统一配对 runner
  probe.mjs               不调用模型的后端/扩展连接探针
  report.mjs              报告生成器
  tasks.json              任务目录元数据
```

运行测试：

```bash
pnpm --dir benchmark test
```
