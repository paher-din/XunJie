# WP09 真实模型 ALU 页连续验收

2026-11-08，原 DeepSeek Chat 真实生成的 ALU candidate 经 r2 正式 Chrome 检查并采用，通过正常 Monaco 输入工程 fixture，再点击原页「运行单次实验」，得到真实 Icarus `F=0000、Cout=1`。r3 在同一 private root、同一 revision 和同一 execution 上完成重启读取、刷新恢复及窄桌面导航检查，未重发模型 Run 或执行请求。

最新报告为 [real-alu-r3-ui.json](real-alu-r3-ui.json)。[real-alu.json](real-alu.json) 记录 r2 首次执行及 probe 断言失败后的原 request 续验；[real-alu-r3.json](real-alu-r3.json) 记录 r3 最小只读续验。模型生成的既有依据见 [real-models-product-r2.json](real-models-product-r2.json)。本次新增 generation 为 **0**，共享总额仍为 **20/24**；无模型修订。

最终清理已于 **2026-11-08T13:43:55.123Z** 完成：确认 host/PG stopped、无本任务所属运行进程、无 `postmaster.pid` 且无进程打开 root 内文件后，调用 r3 产品 `deleteEnvironment({ environmentId: '44a7c996-4935-4da5-a67c-f6ab6c544c33' })`，再删除本任务的私有 handoff 和 root 外壳。原 `/private/tmp/xj-wp09-real-models-20261108` 已不存在。repo 的 20 个 real-models/real-alu JSON 报告与 PNG 截图保留，删除前后 hash 一致。下表和 JSON 中的 stopped/retained 状态仅为**当时验收与交接事实**，不代表环境仍可恢复。

| 验证点 | 实际结果 |
| --- | --- |
| 原 candidate 采用 | `script-syntax`、`fixed-resources`、`capability-scope`、`browser-roundtrip` 全部 passed，candidate 为 adopted |
| 原生成来源 | 原 Run completed、generation command completed、snapshot/attempt 一致，原 resource SHA 未变 |
| 工程 fixture | 从 `scripts/probe-wp09-alu.mjs` 读取既有 CORRECT 工程 fixture，通过正常 Monaco 输入并验证 `alu.sv` owner 内容 hash；未改学生 starter、Agent code 或生成 payload |
| 原页执行 | 原生成页面按钮实际提交 `icarus-alu / alu / run-single`；`A=15,B=1,M=1,S=0,Cin=0`，query 为 succeeded/confirmed，F=0000、Cout=1 |
| 点击依据 | 原 action 固定引用点击时 `alu.sv` 的 object/content/hash 和原页面 componentId/version/definitionDigest，initiator 为 student |
| 结果身份 | action、receipt、query、acceptance、retained artifact 的 requestId/inputDigest/executionRef 关系通过；保留结果正文 SHA 与 query artifact SHA 一致 |
| 普通中文输入与刷新 | owner 保存解释字符串；刷新读回相同输入、原 request、query 和保留结果，execution history 不变 |
| r3 包 | 实际使用 `dist/wp09-macos-r3/app/product-runtime.js`；服务的 index 与 `runtime-CyAbAhBT.js` 字节 hash 等于包内资源 |
| r3 重启 | 原候选已采用、同一代码/页面来源/执行/结果仍可读；新增 provider attempt、模型 Run、execution 均为 0 |
| 1024×800 | 原产物在正式中心工具区打开；实际截图包含解释输入、原运行按钮和可信结果区 |
| Tab 焦点 | Tab 从解释输入到原运行按钮，`:focus-visible` 为 true，outline 为 solid/2px；Shift+Tab 返回解释输入；未点击按钮 |
| 导航保留输入 | 普通中文输入保存后，浏览器后退至列表、前进返回活动，以及点击「返回活动列表」后浏览器后退返回，均读回相同输入和原结果 |
| UI 续验请求 | 290 个 GET/200、1 个 POST/200（作品普通输入）；execution POST 为 0，HTTP 错误为 0；原 conversation 仍仅原 Run |
| 停止与保留 | host/PG 已 stop；private root 内无 `postmaster.pid`，`installation.json` hash 未变；学校 handoff 仍为 0600，仅内存解析 |

| 身份 | 值 |
| --- | --- |
| activityId | `2d0c7f14-143b-423e-a8e9-8a7d66336785` |
| artifactId | `57a8b4fd-2d77-432e-a3d1-9a534689e94e` |
| revisionId / version | `3359348c-cc43-4906-9755-85ceb7b8ebd8` / `1` |
| candidateId | `3dbb05d9-13eb-4966-a365-b0c2bfd0e4e7` |
| 原 generation Run | `d80c9f0a-ab67-4e15-8f26-04fd4f708929` |
| 原 generation requestId | `10e2011b-75db-4afa-9d4c-78a9b4b9410c` |
| 原 generation commandId | `1e199851-8805-44ad-9075-5bae79a607d6` |
| 原执行 requestId | `a49c8d63-8364-4be2-ad3d-6f6b14f5e2d0` |
| 原执行 executionRef | `2b2a781c-5ffc-4a6d-9f42-dd0c9878421f` |
| 原执行 inputDigest | `d7dedac16fce3b0216246970401116bbe20733874b7a80ac3e753c46dd73ef43` |
| 原模型 resource SHA256 | `daad6676ad044768002ca7e0cfdf040902163b57304a8e9ab4a9095a5327ac74` |
| 工程 fixture SHA256 | `ddb00cb54a10ad75c38a2120360220265abafbe8a0413109886300c103348a0b` |
| 保留结果正文 SHA256 | `1986b272809f2e49c641f52d923e2ec8ccad2dcb2826ed25016473aae999783b` |
| r3 distribution SHA256 | `1d527d22a6d25e2fdb1c6c5e7194b2fb0f2a7b8349c79c24afbc7780de2dcc56` |
| r3 Web runtime SHA256 | `feb24e4e9c986f9a2443a835696e3f75e8d566e121094e16b9377d3778b1ae50` |

首跑真实 Icarus 已成功，但 probe 错误地要求 retained artifact 提供 `inputDigest`，造成 `retained-result-is-not-original-execution`。契约实际在 query/receipt 上提供 inputDigest，artifact 用 requestId/executionRef/SHA 关联。只修正 probe 断言，随后复用同一 request 通过；未再点击运行、未修改模型产物。该失败保留在报告 `failures`、历史 failed stage 及 [实际失败时截图](real-alu-failure.png)。

实际 Chrome 截图均为原运行界面，未编辑图片：

- [r2 原页实际 Icarus 结果，1440×1000](real-alu-actual-icarus.png)
- [r3 原 request 重启/刷新读取，1440×1000](real-alu-r3-restored.png)
- [r3 中心原页与 Tab 焦点，1024×800](real-alu-r3-ui-narrow-tab.png)
- [r3 离开/前进后退后输入与原结果，1024×800](real-alu-r3-ui-narrow-restored.png)

清理前，私有 root 为 `/private/tmp/xj-wp09-real-models-20261108`，最小只读复核使用最新报告。下面保留历史操作命令；原环境现已删除，不能再对本轮 root 执行 resume：

```sh
rtk bypass dist/wp09-macos-r3/resources/node/bin/node scripts/probe-wp09-real-alu.mjs \
  --product dist/wp09-macos-r3 \
  --resume docs/student-agent-implementation/evidence/wp09/real-alu-r3-ui.json \
  --read-only \
  --out docs/student-agent-implementation/evidence/wp09/real-alu-r3-recheck.json
```

清理前追加 `--ui-checks` 已实际覆盖普通解释输入、1024×800、Tab 与导航恢复。`--read-only` 禁止编辑代码和新 execution；`--ui-checks` 显式允许普通解释输入。供应商请求在 probe 中被阻止；不读取供应商凭据。采用包内生产 host/application，启动时仅在内存选择包内 Web 路径；验收期间原安装配置保持不变，最终清理时随环境删除。Chrome→host 为本机 loopback HTTP；本次没有新的供应商 HTTP/TLS 请求。

工程检查：固定 Node 24.21.0 的 `--check` 通过；该 probe 与 real-alu 文本证据共 5 个文件无尾随空白。没有启动全量构建或重复产品测试。

本证据覆盖原真实生成页的单一 run-single 实际链路及保留读取，不替代 ALU 全部 4096 输入、预测 case、教学效果或 Windows 的验收。未提交代码，未修改产品或其它 probe。
