# WP09 真实模型验收

源生产入口的本轮验收通过，累计 **20/24 次 generation，剩余 4 次**。完整事实见 `real-models.json`。每次供应商调用最多 8192 output tokens、绝对截止 60 秒、SDK retry=0；限制只属于 probe。

最终清理已于 **2026-11-08T13:43:55.123Z** 完成。原私有环境 `/private/tmp/xj-wp09-real-models-20261108` 在确认 host/PG stopped、无本任务所属运行进程及打开文件后，经 r3 产品 `deleteEnvironment` 校验原 environmentId 并删除产品数据，再移除本任务 handoff 和 root 外壳；该路径现已不存在。repo 的 20 个 real-models/real-alu JSON 报告与 PNG 截图均保留，删除前后 hash 一致。本文及 JSON 中的 stopped/retained 是**当时的验收与交接事实**，不表示原私有环境当前仍保留；历史 resume 命令已不能用于该已删除环境。后续原 ALU 页的实际采用、真实 Icarus 及 r3 零调用续验见 [real-alu.md](real-alu.md)。

| 路线/范围 | 实际调用 | 结果 |
| --- | ---: | --- |
| DeepSeek Chat Completions | 生成 2 + 修订 3 | 原 artifact 的 v1 → v2，完整原来源与资源保留 |
| DeepSeek Responses | 生成 2 + 修订 3 | 原 artifact 的 v1 → v2；Chrome 独立检查、直接首次采用最新背景修订、中文保存/刷新/工具区开关恢复通过 |
| DeepSeek Anthropic Messages | 生成 2 + 修订 3 | 原 artifact 的 v1 → v2；Chrome 独立检查、直接首次采用最新背景修订、中文保存/刷新/工具区开关恢复通过 |
| Chat → Responses | 读取原版本、修订、结算共 3 | 同一 Chat artifact 的 v2 → v3；纠正原生成脚本的 SDK read 包装层访问，保留中文输入；采用、刷新和工具区开关恢复通过 |
| ALU 学校课程 | 生成 2 | 真实模型生成含明确 run-single 按钮及 execution.submit 能力的候选；未执行实验、未填写预测、未改作品 |

三个当前交互页面均已由正式桌面 Chrome 采用，使用单一 explanation 字符串状态，结构与语义摘要保持一致。Chat 原 v2 的生成代码错误被保留在原固定版本中；只有原计划的跨路线 v3 修订纠正读取方式，不回写旧资源或来源。

全部生成从真实生产 HTTP ActionIntent 进入 RunDriver → ModelGateway → 产物 owner，使用原 generate_teaching_artifact/read_teaching_artifact，不使用模型桩、不直接发布预制产物。每个模型快照的 payload 摘要都与实际供应商传输匹配，原 Run、command、attempt、snapshot 与固定 revision 相互对应。

重建生产 host/owner 后，原候选、版本、资源、来源、请求回执、对话和工作区摘要一致，Chrome 重开当前页面恢复中文输入，新增模型调用 0。原 v3 定义与历史 Run 保留，新调用使用 definition v4；不把同一版本改成不同 Prompt。旧 15 次调用也已在后续独立 probe 进程中重读。本文不把同一进程内的 host 重建扩称为整机断电恢复。

## ALU 续验交接

本节记录生成候选时的交接事实，当时仅证明真实生成、固定来源与候选静态检查，未声称 ALU 页面已采用或真实 Icarus/预测案例已通过。生成前后工作区摘要一致，执行历史新增记录为 0。后续实际采用和单次 Icarus 已在 [real-alu.md](real-alu.md) 连续验证，预测案例不由本报告推定。

| 公共身份 | 值 |
| --- | --- |
| activityId | 2d0c7f14-143b-423e-a8e9-8a7d66336785 |
| artifactId | 57a8b4fd-2d77-432e-a3d1-9a534689e94e |
| revisionId | 3359348c-cc43-4906-9755-85ceb7b8ebd8 |
| candidateId | 3dbb05d9-13eb-4966-a365-b0c2bfd0e4e7 |
| runId | d80c9f0a-ab67-4e15-8f26-04fd4f708929 |
| component / operation | alu / run-single |
| resource SHA-256 | daad6676ad044768002ca7e0cfdf040902163b57304a8e9ab4a9095a5327ac74 |

交接时原隔离环境已停止并保留，学校登录信息只在该 root 的 `wp09-real-models-handoff.private.json`（0600），不进入本报告；当时供主验收脚本用同一环境接真实执行。最终清理已删除该私有文件及原环境。

## 复跑

使用 Node 24.21.0、PostgreSQL 18.6 和已构建的生产模块。本 probe 不运行构建；完整模式需要桌面 Chrome。`--product` 从实际产品包读取 app/product-runtime.js、resources.json 及该包 Web，不用源码 Web 替换产品资源。

```sh
probe_node="$PWD/dist/product-darwin-arm64-wp07-203-final-r4/resources/node/bin/node"
export XUNJIE_PRODUCT_POSTGRES_BIN="$PWD/dist/product-darwin-arm64-wp07-203-final-r4/resources/postgres/bin"

# 零 generation：检查已构建 SDK 输出契约和真实 TLS。
"$probe_node" scripts/probe-wp09-real-models.mjs --prepare-only \
  --out docs/student-agent-implementation/evidence/wp09/real-models-preflight.json

# 新的完整验收环境：三协议生成/修订、Chrome、跨路线与重启。
"$probe_node" scripts/probe-wp09-real-models.mjs \
  --out docs/student-agent-implementation/evidence/wp09/real-models-fresh.json

# UI 尚未构建时先生成候选，保留环境待继续；PRIVATE_DIR 必须是新目录。
"$probe_node" scripts/probe-wp09-real-models.mjs --candidates-only \
  --root PRIVATE_DIR --out docs/student-agent-implementation/evidence/wp09/real-models-candidates.json

# 继续同一环境：已有 Run 只读取，共用原证据的累计预算；ALU 分支预留至少 3 calls。
"$probe_node" scripts/probe-wp09-real-models.mjs \
  --resume docs/student-agent-implementation/evidence/wp09/real-models-candidates.json \
  --root PRIVATE_DIR --alu --keep-root \
  --out docs/student-agent-implementation/evidence/wp09/real-models.json

# 最终新产品包最少核验：Chat 真实生成、采用、输入和重启；继承最新累计 20 次预算。
"$probe_node" scripts/probe-wp09-real-models.mjs --product PRODUCT_DIR --product-minimal \
  --budget-from docs/student-agent-implementation/evidence/wp09/real-models.json \
  --out docs/student-agent-implementation/evidence/wp09/real-models-product.json
```

本轮当前不重跑 fresh 示例。r2 Mac 产品包已按下节完成原环境零调用续验；fresh / product-minimal 命令仅作为未来复跑示例，不属于本轮新增调用。`--browser-only` 只做原候选的 Chrome/恢复，不启动跨路线生成。成功完整模式默认删除自己创建的隔离环境；`--keep-root` 和 ALU 交接模式保留停止后的原环境。

默认私有配置为 `~/.config/magpie/providers.json`，只按 JSON `providers.find(p => /deepseek/i.test(p.preset ?? p.name ?? '') && p.key).key` 取密钥，不尝试旧逐行格式。密钥只用于内存及临时产品环境的正式凭据保存。报告不写配置正文、HTTP 请求/响应正文、原生 thinking、生成脚本、登录凭据或学生状态正文；仅保留公共身份、版本、摘要、状态、usage 和实际传输/HTTP/TLS 事实。

## TLS 和网络适配

实际供应商路径保持 api.deepseek.com 的 /v1/chat/completions、/v1/responses、/anthropic/v1/messages，20 次请求均 HTTP 200，TLS 1.3 且 authorized=true。probe 的 https.request 把原供应商流交给实际 SDK，保持原 Host、SNI、证书验证和请求字节。

当前 OS 代理 DNS 返回 198.18.*。仅在该 probe 进程的模型策略分类处使用公共地址 shim；真实 TLS socket 仍沿 OS DNS 连接原主机。该适配及原解析结果记录在 JSON，未进入产品代码，不宣称覆盖了未适配的直接产品网络路径。

Chat SDK 收到协议终态后会取消尚未 EOF 的 SSE。报告保留实际 finished=false，并用原已完成 Run 和匹配固定快照标明协议终态，分类 consumer-cancelled-after-protocol-terminal；不把取消伪报为 TCP EOF或重试。

## 保留的负例与修复依据

- `real-models-candidates.json`：最初 15 次调用的真实候选及零生成重读；尚未采用的基线。
- `real-models-browser.json`：正式 UI 初次采用原背景 v2 的实际 409。owner 在 active=null 时允许已检查最新 revision，仍保留 work/content/CAS 和后续 parent 匹配检查；修复后 Responses/Messages 的原 v2 直接采用成功。Chat 曾沿原 v1 的公共检查/采用路径先行采用，未用于证明这项首次采用修复。
- `real-models-diagnostic.json`：Chat 原 v2 错把 read 返回包装层当状态；owner 与 SDK 状态摘要正确、DOM 空值。跨路线 v3 后刷新通过。
- definition v3 内容扩展但版本未提升时，probe 在新供应商请求之前以 agent-definition-version-reused 停止；main 提升至 v4 后续验成功，原 v3 记录未改写。

本证据只覆盖本机 Apple Silicon Mac 的源生产入口与桌面 Chrome 156.0.8078.80。Mac r2 原数据恢复见下节；Windows、跨机部署、真实 Icarus/预测与教学效果由对应主流程验收分别记录，不由本 probe 推定。


## Mac r2 产品包最终续验

`real-models-product-r2.json` 为 passed。使用包内 Node 24.21.0、host/app 和 Web，续验原 root、原 environmentId、全部原 artifact/revision/candidate/Run 来源；**新增模型 generation=0，累计仍为 20/24**。该模式不读取供应商凭据，直接拒绝新的供应商 generation，不重发已有 Run，不重新生成 ALU。

原安装的 native Node/PG 可执行文件与 r2 包字节一致。probe 的 host 组合仅在内存选择 r2 webRoot，当时保留原安装配置供后续联调；实际 HTTP 首页和入口脚本摘要分别匹配 r2 包，重启后再次匹配。三条当前交互页的采用事实、原中文状态、刷新、工具区打开/关闭和 host 重启读取通过。验收期间安装文件摘要未变，最终清理时随环境删除。

本段记录 `real-models-product-r2.json` 的采集时事实：ALU 原候选在 r2 中重读通过，当时仍为 candidate；原 revision 摘要、Run、command 来源一致，未重复发布或执行，root 停止并保留供后续联调。随后原页的采用、Monaco 工程 fixture 和真实 Icarus 见 [real-alu.md](real-alu.md)；该 root 现已最终清理。

```sh
# 本轮实际命令；继续已通过源证据，禁止新模型 generation，保留原 root。
dist/wp09-macos-r2/resources/node/bin/node scripts/probe-wp09-real-models.mjs \
  --product dist/wp09-macos-r2 \
  --resume docs/student-agent-implementation/evidence/wp09/real-models.json \
  --root PRIVATE_DIR --keep-root --screenshots \
  --out docs/student-agent-implementation/evidence/wp09/real-models-product-r2.json
```

截图由正式首页外观菜单选择浅/深色，再打开同一 Responses 原产物 v2 的中心工具页；未改 DOM 配色、未编辑图片。截图均为真实 Chrome 1440×1000，可与 before/activity-page.png 对照。

| 主题 | 实际截图 |
| --- | --- |
| 浅色 | [real-models-product-light.png](real-models-product-light.png) |
| 深色 | [real-models-product-dark.png](real-models-product-dark.png) |

截图的固定 activityId/artifactId/revisionId、资源摘要和 PNG 摘要见 product-r2 JSON。准备截图时发现沉浸页隐藏主题按钮，probe 已改走正式首页外观菜单；两种主题拍摄之间关闭中心页，以免回到原活动时已恢复打开的中心页导致内联 iframe 定位错误。这些是 probe 导航适配，未修改产品。
