# 构建与验证耗时

本轮以 `0f2fd89b016c5c5e64a9019d5ba46ab73967d0b3` 为业务代码基线，使用 Node 24.21.0。测试发现集合、local/external 分类、原有断言、真实密码计算参数和有意义的时序等待均保留。工程验证不代表桌面 Chrome 或教学效果验收。

## 优化前

2026-11-01 使用 `gh` 收集最近 50 次运行和全部 job；其中 ci 有 23 次成功、9 次取消、6 次失败，cloud-release 有 12 次成功。旧版发布流程的 7 次短运行与当前完整验证版本分开统计，失败及取消不计入成功耗时中位数。

| 指标 | 成功样本中位数 |
| --- | ---: |
| CI job 墙钟时间 | 617 s |
| Runner 排队 | 3 s |
| Checkout、Node 和依赖安装等环境准备 | 20 s |
| typecheck 阶段（原入口含重复构建） | 29.1 s |
| build 阶段 | 43.0 s |
| test 阶段（原入口含重复前置构建） | 516.7 s |
| 测试报告实际执行耗时求和 | 488.0 s |

各行独立取中位数，不能直接相加。排队以 job 创建至 runner 开始计，workflow 派发至 job 创建另计；上传和发布尾部也单独保留。取消中的未完成测试只有观测下界，不视为零耗时或通过。

[基线 CI](https://github.com/paher-din/XunJie/actions/runs/41302756261) 的 server 测试为 269.2 s、tools 为 190.2 s；同一 main 提交的 cloud-release 又执行了一次完整验证。macOS arm64 的干净源码副本连续构建为 15.73 s、14.40 s。

## 优化结果

| 指标 | 优化前 | 优化后 | 耗时变化 |
| --- | ---: | ---: | ---: |
| 完整 CI 墙钟时间 | 617 s | 165 s | -73.3% |
| 同机完整本地验证 | 366.849 s | 172.014 s | -53.1% |
| 完整构建／强制构建 | 15.73 s | 10.877 s | -30.9% |
| 无改动二次构建 | 14.40 s | 0.453 s | -96.9% |
| PR 的 runner 实际总分钟数 | 10.28 min | 11.92 min | +15.9% |

优化后完整 CI 样本为 [f245b22 的运行](https://github.com/paher-din/XunJie/actions/runs/41314971393)：包含排队的墙钟时间 165 s，各 job 实际运行时间求和为 715 s。基线 617 s 为成功 job 中位数，未额外加上其排队，因此此处对提速采用较保守的比较。runner 分钟是实际秒数求和除以 60，未做账单取整。PR 并行测试增加少量总计算时间，以换取更短等待；main 已移除发布流程中的第二次完整验证，本轮未执行 main 实际发布。

此前同一测试集合、同一调度版本的三次完整 hosted 采样为 [attempt 1](https://github.com/paher-din/XunJie/actions/runs/41313545265/attempts/1)、[attempt 2](https://github.com/paher-din/XunJie/actions/runs/41313545265/attempts/2)、[attempt 3](https://github.com/paher-din/XunJie/actions/runs/41313545265/attempts/3)：分别为 200、177、193 s，中位数 193 s，较基线降低 68.7%；runner 实际总时间分别为 852、805、849 s。随后依据实测继续修正本地调度和相同产物更新，得到表中的完整样本；各轮结果按版本保留，未混为同一版本的中位数。

本地验证使用同一 macOS arm64、Node 24.21.0 和业务代码基线，先后运行，未同时运行两套完整验证。强制构建后两次公开构建入口复跑为 0.475、0.453 s。初期一次 main fencing 用例发生超时，另一次启动 PATH 缺少本机已有的 sha256sum；两者未计为成功基线。修正启动环境后取得 366.849 s 的完整成功基线。

## 保留的校验与关键改动

- 原有 1,099 个可从 Node 日志提取的业务用例名称全部保留；Node 总用例从 1,127 增至 1,200，增加的是构建、调度和工具回归。原有跳过数量均为 19；Web 仍为 58 个文件、688 项通过，Python 部署回归 34 项通过。
- 保留真实密码计算、完整恢复源码范围、传输数据规模、故障注入、原有超时与断言；本地／外部测试分类及现有环境门控不变。
- 构建按内容、工具链、安装图和完整输出复用，测试每次执行。契约在临时目录编译；结果一致时保留已有目录，避免不同 NODE_OPTIONS 的真实 CLI 重建干扰读者；变化时清理陈旧产物。
- 修正恢复工作树的 workspace 依赖归属；Git blob 按大小批量读取，保留路径、类型、权限、长度、摘要及敏感内容检查。
- CI 一次准备、四片 server、四组 tools 和 unit 并行，测试 runner 的环境准备中位数仍约 20 s。server 按 hosted 权重分片；本地无分片保留字典序，避免同时启动全部高内存密码计算用例。
- 独立测试共享最多四个 worker；有严格时序要求的 fencing 用例单独执行。保留立即取消快照和后代身份校验，将周期性进程扫描从 100 ms 调至 500 ms。
- 修正既有连接测试的清理竞争：等待在途 handler 释放锁后再删除临时目录，未改业务断言或期限。

## 工作流行为验收

- 连续推送后，[旧 PR 运行](https://github.com/paher-din/XunJie/actions/runs/41310568890)自动取消；main 的并发组按运行 ID 区分。未为验收向 main 推送提交。
- [纯文档验收 PR #161](https://github.com/paher-din/XunJie/pull/161)仅修改 Markdown，未创建 Actions 运行，检查列表为空；已关闭并删除临时分支。当前分支保护及 ruleset 无必需检查，未修改保护配置。
- [故意类型错误的发布门禁演练](https://github.com/paher-din/XunJie/actions/runs/41312364753)在 prepare 失败后跳过测试和发布 job；临时错误不在交付分支。
- [publish=false 装配演练](https://github.com/paher-din/XunJie/actions/runs/41313727676)完整通过，核验构建 artifact、隔离安装生产依赖、装配并上传 runtime 证据；创建 Release 和清理旧发布两个步骤均跳过。

原始 50 次运行、逐 job 明细、各轮本地日志和覆盖对比保存在本机 `.verification/performance/`，不进入 Git；hosted 原始日志和 artifact 保留 7 天。工程验证不代表桌面 Chrome、跨机器原生环境或教学效果验收，本轮未新增这些验收。
