# HDL 执行节点准备工具

本目录现在只保留与**专用执行 VM** 和**共享构造件**相关的工具。旧本机业务宿主（`xunjie-local.ps1` 3444 入口、初始化与证据脚本）已退役并删除；本地全栈开发统一使用 [`tools/xj-dev`](../xj-dev/README.md)（诊断/启动/状态/停止，HTTPS 单一入口 + 独立数据基线）。

## 保留内容

| 文件 | 用途 |
| --- | --- |
| `local-node-setup.ps1` / `local-node-setup.sh` / `local-node-setup.guest.sh` | 一次性准备专用执行 VM（Ubuntu/WSL2、冻结镜像与 runner）；属于 VM 侧准备，不是业务宿主入口 |
| `local-node-setup.import.mjs` / `local-node-setup.receipt.mjs` | VM 准备的镜像导入与就绪收据生成 |
| `receive-frozen-images.mjs` / `receive-frozen-images.ps1`（及测试） | 接收冻结执行镜像的受控通道 |
| `receive-public-base-materials.ps1` | 接收公开基础材料 |
| `install-editor-diagnostics.mjs` / `editor-source.mjs` | 从已安装并构建 contracts 的 app server staging 装配 editor 节点源码；保留 runner/contracts 目录并复制公共 contracts 编译产物及其依赖，不在 VM 安装整个 workspace |
| `fixtures/hdl-reference.json` | HDL 参考事实，`apps/web` 工作区测试直接读取 |
| `seed-local-courses.mjs` | 仅保留 `tools/i0-cloud/publish-demo-projects.mjs` 使用的 `verifyCompletionReceipt`；退役宿主的独立场景 CLI 已删除。新场景与交接使用 `xj-dev baseline/repro` |

## 边界

- 这些工具不启动业务系统，不提供本地页面或 API；本地开发一律走 `xj-dev`。
- 工具不携带密码、私钥或 API key；受控材料按既有授权目录存放。
- 云端共享与演示发布见 `tools/i0-cloud/`，与本地闭环相互独立。

冻结 `9fa76ad` 工具按原 SHA/摘要读取原 `apps/teaching` 布局，不消费当前 checkout。当前 editor staging 使用 `apps/server` 的 runner 与 contracts（含 internal），且需先从仓库根完成 `npm ci --include=dev` 和 `npm run build -w @xunjie/contracts`。装配脚本会实体化公共包及其声明的运行依赖，既有 VM 的 config.source 和独立 `.ts` worker 入口不随 Web/server 编译产物改名。
