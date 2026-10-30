# 可靠作品编辑与自动保存

对应 [#151](https://github.com/paher-din/XunJie/issues/151)，范围依据 [WP02 规范](specs/wp02-learning-space-and-reliable-workspace.md)。本票接续 [学习活动入口](wp02-identity-activity.md)，不需要课程发布、模型、Agent 或执行服务。

## 使用与模块归属

正常产品入口建立或打开自主学习活动后，在「当前作品」新建、编辑、重命名或删除文本/代码文件。输入即时呈现，自动保留与同步；没有手动保存、确认或冻结步骤，也没有常驻保存状态。只有存储失败、授权失效和需要处理的分歧才提示；失败时保留当前页面与可复制/导出内容。

Web 的 [共同工作区接口](../../apps/web/src/reliable-workspace/README.md) 统一本机事务、待同步项、回执与竞争；正式页面和现有 Monaco 编辑器共同消费它。名称、路径和稳定对象身份分离；编辑器保留原文 BOM/换行，重开使用新的编辑器实例范围，避免旧 model 覆盖新正文。

学习数据 owner 提供 `learning.works.read/sync/receipt/content`，HTTP 路径为 `/api/learning/workspaces/<activityId>`，其下 `receipts/<requestId>` 与 `contents/<contentId>` 为只读查询。访问先经过真实主体、活动与服务绑定校验；客户端连接学校时沿原连接代理，不改换 owner。

## 数据、维护与恢复

学习数据迁移新增作品 head、对象生命周期、不可变内容归属、版本与请求关系。一次同步以预期远端 revision 和稳定请求 ID 执行；同一 ID 不同输入被拒绝，过期基线返回 conflict，不按回包顺序或本机时钟覆盖。

正文使用 UTF-8/base64/JSON wire，持久内容统一先经所属 storage 的资源写入与重读校验，再在所属短事务共同发布引用、版本、对象状态和回执。当前 wire 支持 64 个对象，总 value 不超过 100 万 UTF-16 单元。已发布历史内容保留引用，重命名、编辑或删除当前文件不释放历史资源；删除对象留下 tombstone，同名新建取得新身份。

owner 的维护与恢复校验覆盖当前 head、不可变版本、内容归属、资源字节及回执。沿用正式 CLI 的完整备份、独立恢复、隔离及接管；源退役后拒绝后续操作，旧浏览器恢复命名空间不能直接写入新实例。已有 schema 的升级使用旧版本持有的完整备份和新版本 CLI `upgrade` 的 `kind: "schema"` 输入流程，不在正常编辑路径暗中迁移或绕过维护。

浏览器使用全新的 IndexedDB 命名空间；不读取、删除或自动迁移旧演示库。服务端备份只包括服务端已接收状态，不包含尚未同步的浏览器正文。

## 可重复验证

使用 Node 24.21.0、完整 PostgreSQL 18.6 分发；`XUNJIE_PRODUCT_POSTGRES_BIN` 指向其 bin。正常构建后：

```sh
node --test packages/product-runtime/test/works.runtime.test.mjs
XUNJIE_XJ_DEV_URL=isolated-native-product XUNJIE_E2E_BROWSER_CHANNEL=chrome \
  npm exec -w @xunjie/web -- playwright test worksEditor.spec.ts --headed --workers=1
npm run typecheck
npm run build
npm run check:contracts:browser
npm test
```

Chrome 用例自己建立隔离产品环境；这里的 `XUNJIE_XJ_DEV_URL` 只关闭旧 prep/real 测试服务器，不替代产品 API。故障在真实 HTTP 边界延迟/丢弃回包，在浏览器 IndexedDB 写入边界抛出配额错误；双标签竞争仅暂停周期任务的发放，保留原生时钟和真实 IndexedDB 事务。测试不 mock 工作区内部模块或使用内存数据库。

本机工程、Windows Chrome 结果与未执行项在交付时分别记录。Apple Silicon Mac 的实际执行项集中在 [#155](https://github.com/paher-din/XunJie/issues/155)，不以 Windows/API 结果代替。教学效果不评估；本票 PR 不自动关闭仍待 Mac 的验收事项。

## Windows 交付验证（2026-10-31）

Windows 11 x64（build 26200），Node 24.21.0、PostgreSQL 18.6，本机安装的 Google Chrome 156.0.8078.76，有头执行；没有用 Playwright 自带 Chromium 代替。

- 全仓类型检查、全量构建、7 个公共契约浏览器导出检查通过；最后的页面修复重新执行类型检查与产品页构建通过。
- 原生 PostgreSQL 集成 **10/10 通过，0 跳过**：作品 API、身份/活动路径、正式 CLI 恢复及 schema 升级校验。作品断言覆盖中文/BOM/CRLF、重命名与删除重建身份、不可变历史资源、较大二进制与 JSON 状态、请求幂等、竞争、跨主体隔离、重启、三 owner 备份恢复接管和恢复命名空间隔离。
- 桌面 Chrome **14/14 通过，0 跳过**：真实 Monaco、IndexedDB、产品 API、原生 PG 和文件资源。覆盖离线编辑与重载续传、迟到/丢失回执、持续输入、初次和持续存储拒绝后自动恢复、导航失败/迟到导航、双标签本机竞争、独立浏览器上下文远端竞争、旧编辑器 model 隔离、UTF-8 BOM/CRLF、退出学校登录与切换空间交错。截图额外等待真实正文渲染后采集。
- `npm test` **整体未通过**：checks 27 通过/1 跳过；product-runtime 98 通过/18 失败/5 跳过；storage 12 通过/1 失败/1 跳过；server 640 通过/2 失败/19 跳过；Web 58 文件/688 项通过。失败分布与 [#149 已记录的本机基线](wp02-identity-activity.md#验证与限制) 一致，涉及连接/恢复超时、Windows 符号链接权限及 `LOCAL_SOCKET_CONFLICT`。这不是绿色门禁；工作区聚合退出后末尾 tools 组未执行。本票受影响的原生集成与 Chrome 路径另按上文实测，不以跳过充当通过。
- 代码审查按 Standards / Spec 两轴进行；已修复审查发现的确认、冲突、导航及退出生命周期问题，最终两轴均无剩余发现。

Mac 尚未执行，具体检查集中到 #155；教学效果未评估。本次不合并 PR。
