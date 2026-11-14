# #217 跨机器 Skills 验收

本文保留旧版本的验收历史；旧 Agent 探针已退休，文中脚本名仅标识原证据来源。当前 session v2 工程入口为 [skills.runtime.test.mjs](../../../../packages/agents/test/skills.runtime.test.mjs)、[session-dependencies.runtime.test.mjs](../../../../packages/agents/test/session-dependencies.runtime.test.mjs)。这些测试不继承本页的历史通过结论，真实供应商、桌面与跨机结果须另行验收。

探针为 历史脚本 `probe-teaching-assembly-cross.mjs`（已退役） 的 `--skills` 分支。沿用真实生产 owner、分发内 Node/PG、连接授权、模型 gateway、原 Action 与原 Agent 运行循环；不另实现 transport 或运行循环。

实际结果：2026-11-07 19:31–19:32 UTC，10/10 通过，见 [真实跨机报告](cross-owner.json)。使用主 agent 确认的 `dist/wp08-217-macos` 与 `dist/wp08-217-windows`，没有构建或使用旧分发。两平台 application SHA256 为 `37cd20484c1be3464d9730fabbf65326e15495e53f1e48ada9419a33d5283ffb`。

目标拓扑：Windows 独立 Agent → Mac 课程数据/模型 owner，直接 LAN HTTPS；SSH 仅用于控制。供应商 key 仅在 Mac 配置/内存中，最多 2 次真实 DeepSeek 请求，每次最多 2048 输出 token、30 秒，0 自动重试。

`--skills` 使用独立 217 临时环境前缀，默认端口为 Mac 39217、Windows 39218；可显式替换。测试 TLS 文件及私钥只存双方临时目录，验收后清理，不入证据或 Git。不操作物理桌面。

验收内容：固定课程包与附件；实际 Windows Agent 服务离线时保留原 Action；依赖 grant 撤销拒绝新操作；恢复同一 owner 并换发 grant 后沿原 Action 继续；真实 `skill_read` 返回原附件；step manifest 固定实际附件及摘要且保持 native tool pairing；Windows 进程重启后纯读不新增模型或工具操作；最后撤权后新目录和附件读取拒绝、不披露字节。

实际调用为 2 次真实 DeepSeek HTTP 200，分别耗时 2771 ms 和 2230 ms，无自动重试。Windows 服务实际停止后原 Action 的 ID 和摘要保留；依赖撤权后目录 HTTP 403、附件 RPC `forbidden`，未披露附件字节。Windows 重启读取原 conversation、events、request 与两份 snapshots 不变，新增模型和工具操作均为 0。

模型中继、双方临时环境均已停止并删除；本票临时防火墙规则、TLS 私钥和传输归档已清理，见 [清理实测](cross-cleanup.json)。共享只读 Windows 分发按主 agent 要求保留至 UI 验收结束，不把共享包列为已清理。没有操作物理桌面；浏览器未运行，教学效果未评估。
