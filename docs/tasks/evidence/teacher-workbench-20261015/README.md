# 教师工作台真实浏览器证据

本目录属于 [I1-TEACHER 任务](../../I1-TEACHER_UI_WORKBENCH.md)，只记录 `https://127.0.0.1:3444` 的隔离合成开发验证，不计真人学习、教学效果或 PAHER 验收。

- [C 最终浏览器结果](c-browser.json)：从既有检查点接续，核对原对象、两次固定提交、反馈历史与独立后续草稿；1440/720/390 三宽共 12 个布局全部通过，无页面错误。新私有材料隔离未在既有 C 固定活动上补造。
- [HDL 最终浏览器结果](hdl-browser.json)：相同三宽 12 个布局通过，第二次提交后学生仍可读取原反馈修订历史。两个角色实际加载的模块入口均为 `index-B66OM0mG.js`。
- [HDL 材料、设计和首个保存过程](hdl-private-material-and-save-progress.json)：保留中途脚本因缩进比较失败的原记录；其中三用途默认关闭、私有类型禁选、三角色真实投影和裁剪、发布分配、原保存回执均通过，整体 `status=failed` 没有改写。
- [HDL 反馈与修订完成](hdl-feedback-revision-completion.json)：42 项断言通过，包含原保存精确消歧、反馈两版、学生消费许可、新原文与原回执的 SHA 一致、再次提交、后续复制；[两次实际确认原文](hdl-confirmed-sources.json)区分原回执/GET 恢复的首版与从 Monaco 全选读取的第二版，不 trim 或改写空格。
- [桌面审阅截图](teacher-review-desktop.png)与[390px 审阅截图](teacher-review-mobile.png)：真实服务、真实合成账号，无协议替身；原始 ID 与 SHA 保留完整换行。

最终静态源码 `5d9c5e97271a43ae11dde2f69260477261adc223`，入口 `index-B66OM0mG.js`；后端 `613e5865e9f3ba4a9e5da11691a1b676a9256815`，PID 2728。静态同步前后核对 209 个后端文件不变，154 个静态文件逐 SHA 一致；严格 TLS，未重启、迁移或触碰个人存储。

完整本机 manifest：`/opt/xunjie-ui-local/evidence/teacher-static-only-2026-10-15T06-02-32-522Z/deployment.json`，SHA256 `687dde42faddddb279ef63e1293dc679ad8bc7d072d22ea479771eb085e9f3d9`。此前备份、迁移与统一部署证据位置及失败分别保留于任务记录和 D 盘 artifact；没有覆盖或删除中途失败。

JSON 只包含合成对象 ID、摘要、方法/路径/状态和布局观测，不含密码、Cookie、CSRF、Key 或完整存储导出。C 的中途失败在 `D:/XunJie_Project/artifacts/teacher-live-c-20261015/failure-*.json`，HDL 在对应 `teacher-live-hdl-20261015`，均保留供追溯。

HDL 原保存的消歧只对确切合成 Attempt/actor/版本/115 字符/摘要成立，并以 SQLite `mode=ro` 读取唯一原命令回执；未再次保存或换对象。这个一次性诊断分支在证据保留、原检查点确认后已从通用工具移除；最终工具的未知命令仍停止等待读取确认。移除后再从原检查点运行 C 19 项、HDL 20 项，全部通过；截图均等待学生反馈正文实际加载完毕。
