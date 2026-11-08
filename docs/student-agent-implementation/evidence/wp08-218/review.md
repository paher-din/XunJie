# [WP08：PDF 添加、按页阅读与固定引用](https://github.com/paher-din/XunJie/issues/218)双轴审查

固定基线 `cb104e33604cbfcb8c5c4f294dd5c745e723834c`，实现候选 `78432257227c30878a6418fd372adf203cd520b5`。两个独立审查分别核对规范与 [WP08：PDF 添加、按页阅读与固定引用](https://github.com/paher-din/XunJie/issues/218) / [WP08：Agent 能力、上下文与扩展](https://github.com/paher-din/XunJie/issues/214) 的适用要求，排除 `docs/archive/`。

## Standards

[审查记录](standards-final.json)：没有仍需修复的规范问题。沿用原产品布局、组件、设计 token、owner 与公共契约；文档中的产品包复现命令已更正为在仓库根目录使用包内 Node 运行，面向用户的议题引用采用完整标题链接。第三方许可保留上游原文。

## Spec

[审查记录](spec-final.json)：首轮四项 P2 已关闭：密集搜索/转义文字的模型反馈超限、长页文字缺少续读入口、学校 PDF `/find` 转发遗漏、课程 PDF MIME 识别不一致。修复保留完整结果，动态限制模型投影，新增受当前引用授权的固定文字范围读取，并统一公共转发和 MIME 识别；最终 [32 项 PDF 回归](pdf-runtime.log) 全部通过。

最终未关闭项：Standards 0，Spec 0；两轴均无剩余最严重问题。浏览器、产品包、跨机与真实模型结果另见[证据索引](README.md)，不将工程审查当作教学效果评估。
