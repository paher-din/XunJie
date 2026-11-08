# WP08 #219 证据索引

对应 [#219](https://github.com/paher-din/XunJie/issues/219)，基线 `39d234cf`。本目录只保存本次验收的桌面 Chrome 截图和可复现命令。

## 截图

| 文件 | 场景 |
| --- | --- |
| [before.png](before.png) | 改动前的原活动工作区：没有「个人笔记」入口 |
| [after-add.png](after-add.png) | 在「目标与材料」保存新的个人笔记，列表显示名称、第 1 版和纯文本类型 |
| [after-reading.png](after-reading.png) | 保存并打开个人笔记后，正文在个人笔记阅读区显示，版本和纯文本类型可见 |
| [after-reference.png](after-reference.png) | 个人笔记固定引用进入原问题草稿；引用卡片和正文保持可见 |
| [after-locate.png](after-locate.png) | 从引用/搜索结果定位回固定版本，正文中的选中范围与来源版本保留 |
| [after-final.png](after-final.png) | 最终界面：个人笔记入口、阅读区及原工作区布局同时保留 |

截图使用桌面 Chrome 真实页面（通过本地产品运行宿主 `http://127.0.0.1:59368`），不是静态原型。当前截图中的活动文本为“整理我的电路笔记”，个人笔记为 `电路笔记.md` 第 1 版。

## 可复现工程命令

```bash
XUNJIE_PRODUCT_POSTGRES_BIN=/opt/homebrew/opt/postgresql@18/bin \
  /Users/robertwu/.local/share/xunjie-mac/node-v24.21.0-darwin-arm64/bin/node \
  --test --test-concurrency=1 \
  apps/server/tests/material-search-coverage.test.mjs \
  apps/server/tests/material-search.runtime.test.mjs \
  apps/server/tests/material-search-tool.runtime.test.mjs \
  apps/server/tests/personal-materials.runtime.test.mjs \
  apps/server/tests/student-facts.runtime.test.mjs \
  apps/server/tests/teaching-agent.wp08-integration.runtime.test.mjs \
  apps/server/tests/teaching-agent.maintenance-compat.runtime.test.mjs
```

本轮最终结果：上述 24 个测试全部通过（`tests 24 / pass 24 / fail 0`）；全量 `server` 目标 93 个测试通过，`product-runtime` 19 个通过，`storage` 1 个通过，`contracts` 6 个通过，`checks` 8 个通过，Web 单元测试 1036 个通过。

## 边界

- 以上截图证明真实桌面 Chrome 的入口、可靠草稿、固定版本阅读和定位交互；不构成学习判断或教学效果证据。
- `material-search-tool.runtime.test.mjs` 通过真实产品运行时的 Chat Completions HTTP 请求观察模型收到的工具定义和工具结果；响应端使用本地 fixture，不冒充厂商线上模型。
- 检索成功不等于学生掌握，也不代表教学收益。
