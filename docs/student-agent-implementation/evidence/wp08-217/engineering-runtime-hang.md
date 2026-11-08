# #217 native 全套阻塞：只读现场诊断

结论：本次文件进程不退出由共享构建产物在测试运行中被重建、fixture setup 异常未清理上游 HTTP listener 共同造成。已找到明确的启动异常；现场没有 PG 锁等待或仍在执行 Skills/segment 恢复循环的证据。本记录不是重新运行全套的通过声明。

## 现场范围

只读检查本票 parent PID 40676 及 recovery PID 46548、segments PID 50857。没有发送 signal、kill、修改 owner、构建、启动额外测试或连接其他票 PG。之后主 agent 通知已自行中止这三个本票 PID；本诊断未执行该操作。

首次检查时：

| 子进程 | 已运行 | CPU | 子进程 | TCP 句柄 |
| --- | --- | --- | --- | --- |
| recovery 46548 | 10 分 19 秒 | 0.0% | 无 | 仅 127.0.0.1:65356 LISTEN |
| segments 50857 | 9 分 22 秒 | 0.0% | 无 | 8 个 localhost LISTEN：49301、49302、49303、49304、49305、49307、49308、49309 |

两个进程均没有 ESTABLISHED TCP/PG 连接。segments 源码恰好生成 8 个测试实例。没有为排查不存在的连接而向 PG 发查询。

## 已确认的两种 setup 错误

时间以下为本机 Asia/Shanghai，2026-11-08。

1. recovery 最后 WP03 测试在 773.710917 ms 失败。主 native 日志的 stack 指向 `fixture` 的 `runtime.start()`，不是 WP03 业务或 restore 断言。对应临时源根 `xj-input-control-vZ1mkU` 创建于 03:46:37.591；其 `logs/runtime.log` 明确记录：

   ```text
   Error [ERR_MODULE_NOT_FOUND]: Cannot find module
   .../XunJie/node_modules/@xunjie/learning-space/dist/index.js
   imported from .../XunJie/packages/product-runtime/dist/runtime.js
   ```

2. segments 的 8 个测试全部在 29.6–49.1 ms 内失败。日志均为：

   ```text
   Error: Product web entry is missing.
   at fixture (.../support/teaching-input-control.mjs:58:16)
   ```

   对应 8 个空 fixture 根从 03:46:53.586 到 03:46:53.846 连续产生，仅有 `.locks` 和 `.xunjie-root`，未进入数据库准备。

原日志为 `.verification/wp08-217-native.log`。中止后日志末尾的 pending/cancelled file 项不能当作执行过的回归结果。

## 因果链与源码锚点

- `scripts/build.mjs` 的 workspace 编译任务会移除目标 `dist` 后重新编译；Web runtime 任务同样先删除 `dist-runtime`。`apps/web/vite.runtime.config.ts` 还设置 `emptyOutDir: true`。本轮 root verify 日志确有 `RUN learning-space`、`RUN product-runtime` 和 `RUN web:runtime`。
- `packages/product-runtime/src/runtime.ts` 安装时明确要求 `webRoot/index.html` 存在；daemon 启动则从现有 workspace 的 compiled modules 导入 owner。因此并行重建不只影响 Web，也影响 daemon 的模块解析。
- `apps/server/tests/support/teaching-input-control.mjs:43–59` 先创建并监听模型上游，再 await install/start；setup 没有 catch 清理。直到成功返回 fixture 后，调用方才能进入自己的 try/finally 并调用 `f.close()`。
- 本次失败恰好发生在成功返回之前，留下 1 + 8 个上游 listener。测试断言已经失败，Node 文件进程仍因 listener 保活，占住 `--test-concurrency=2` 的两个文件名额，后续文件无法推进。

## 修复建议，未在本诊断中实施

1. 构建完成后再启动 native suite；同一 workspace 的产物重建与消费它们的 suite 串行，覆盖 package `dist` 与 Web `dist-runtime`，不只等待 Web 构建。
2. fixture setup 从首次分配 server 开始覆盖 try/catch。install/start 失败时也执行上游 `closeAllConnections/close`，并按安装/启动实际完成程度停止本 fixture runtime。未生成 installation 时不盲调依赖安装配置的 stop；已启动但未完成返回时须清理自己拥有的服务。
3. 保留原始 setup 错误，不让 cleanup 异常遮蔽它；部分初始化的目录仅在确认无存活 owner 后按本 fixture 临时前缀处理。
4. 将来锁定此缺口应在现有 fixture 的资源配置 seam 注入不可用 Web root，验证错误及时返回且无 listener 遗留；不需要修改生产 owner 或新增私有测试 API。

主 agent 已安排在稳定构建后重新运行 native 全套。本诊断没有重复 segments 或全套，也没有将暂态产物失败计为 Skills/恢复行为验证通过。
