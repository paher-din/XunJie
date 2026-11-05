# 材料标注样例版本

同一组件身份的已发布版本保持原定义、摘要、资源和活动绑定。当前入口：

| 导出 | 组件版本 | 行为 |
| --- | --- | --- |
| `legacyAnnotationPackage()` | v1 | 原始无依赖视图，读取 `view-v1.html` 的原字节，用于旧发布兼容验证 |
| `preparedAnnotationPackage()` | v2 | #171 的锁定 mark.js 依赖、独立自检与原文高亮；原清单和资源保持原样 |
| `annotationPackage()` | v4 | 保留严格协议与样式，新增 #172 标注对象选择/定位；新资源及导入身份 |

原 v3 已发布字节与绑定继续保留，不由新版默认打包入口重发同版定义。

执行 `node components/material-annotation/package.mjs` 生成 v4 的 `component.json` 与 v2 的 `component-v2.json`。v4 的视图与样式统一为 LF 后再打包；v1/v2 的旧资源保持原字节，原导出包可继续使用。旧打包器在 LF 与 CRLF checkout 曾产生两种 v1 摘要，兼容回归分别核实这两种已有字节，不重写存量定义。

组件导入、课程固定绑定与浏览器验收见[组件宿主交付](../../docs/student-agent-implementation/wp03-component-host.md)和[浏览器执行最终审查](../../docs/student-agent-implementation/wp03-execution.md#最终审查与-pr-182-整合)。

非文本选区与固定副本见 [#172 交付](../../docs/student-agent-implementation/wp03-semantic-references.md)。
