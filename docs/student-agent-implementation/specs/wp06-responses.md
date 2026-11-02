# WP06 #166：Responses 完整接入实施方案

依据 [#166](https://github.com/paher-din/XunJie/issues/166) 与 [母契约](wp06-model-connections.md)，基线 `wp06 @ 478bac7`。沿用母票已批准的生产 Gateway、真实身份/PostgreSQL/资源、实际 SDK→受控 HTTP/SSE 测试边界；浏览器与真实端点另记实际结果。

- 直接使用 `openai@7.42.0` 的低层 `responses.create`，`maxRetries: 0`。不调用工具 helper，不产生 Agent loop。
- 在现有 owner 内接入 Responses 检查、原生结果、图像、工具配对与同段回放。固定 `store: false`，重发完整原生 input/output，不使用远端存储、查询或取消。
- completed 终态与完整原生结果、工具参数应用校验共同决定成功；added 暂缺 arguments 合法，半截参数、未知关键块、终态缺失、失败与取消不可产生工具意图。
- 正式设置消费同一能力投影；不改产品导航、布局或另造设置。路线能力只使用本票产品实现的带日期样本，不从研究结果自动晋升。
- 逐条验证原生 reasoning/items 和图像的持久化、重启、备份/还原；结清工具后跨协议仅携带获准可移植上下文。
- 工程、桌面 Chrome（Mac/Windows）、真实两路端点分别报告。凭据不可用、平台不可达或未执行不计通过；不以其他型号替代目标。
