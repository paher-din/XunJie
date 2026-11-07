# 正式 ALU 虚拟板与全量检查课程包

在仓库根运行 `node components/alu-experiment/package.mjs`，生成 `dist/alu-experiment/component.json` 与 `course.json`。分别使用产品的正常组件导入和课程导入接口登记；学生从课程入口进入活动。本目录不是独立页面或测试接收器。

生成目录包含实际材料与 `runtime/` 固定资源，JSON 是 CLI 使用的相对路径清单。运行中的本机产品可用下列命令导入（`xunjie` 对应产品启动器，Windows 为 `xunjie.cmd`）：

```sh
xunjie component-import --root <环境目录> --file <绝对路径>/dist/alu-experiment/component.json
xunjie course-import --root <环境目录> --file <绝对路径>/dist/alu-experiment/course.json
```

程序化管理端调用可消费 `aluPackage()` / `aluCoursePackage()` 返回的完整 API 请求；CLI 清单不内嵌 base64，也不越出生成目录读取文件。

`alu.sv` 只有端口与 TODO；`single.sv` 为只读采样支架，t=0 设置输入、t=1ns 采样、t=2ns 结束；`check.sv` 为只读全量支架，按 `ROUND`/`SAMPLE` 对 4096 个索引施加 P0/P1 前驱并记录 F/Cout；`self-check.sv` 为独立常量探针，不是 ALU 答案。版本 3 继续声明 `run-single`、`observe-enabled`、`check-all` 三个操作，在原状态中增加预测 / 解释草稿与选择。固定预测归原执行命令，解释修订归原作品 owner，结果与 VCD 归原执行资源；不在状态中复制 F/Cout 或报告。旧版本 1、2 活动保留兼容入口。公开规则与学生操作见 [learning.md](learning.md)。

包固定现有 Icarus 候选的六个 JS/WASM 资源，随对应源码与许可证分发。宿主 Adapter 随产品构建，课程不能提供自己的宿主代码。运行包身份来自 [固定清单](../alu-icarus-runtime/manifest.json)。当前组件为 version 4，沿用 stateVersion 3，固定运行包 0.3.1；新的组件导入请求和课程发布 ID 与旧版分开。旧活动继续按 version 3 和原运行包身份读取，不会随产品升级改写。

WP07 合入后继续复用上述组件 v4；带 Agent 帮助策略的新课程使用独立导入请求 `…0204` 和发布 `…0205`。WP04 原发布 `…0186` 与 WP07 原发布 `…0203` 保持不变，不把新运行包或帮助策略写入旧发布。

修改适配器后用 `node tools/alu-wasm/refresh-adapter.mjs <new-version>` 重验六项工具资源，保留原完整包到 `components/alu-icarus-runtime/versions/<old-version>/`，再更新当前清单与身份；不重新编译或替换已验证的工具链二进制。宿主显式登记当前包和 [0.3.0 原清单](../alu-icarus-runtime/versions/0.3.0/manifest.json)，按活动固定身份选择各自的 Worker；未知版本仍拒绝。发布新身份时同步增加组件版本、导入请求和课程发布 ID，避免与已批准的不可变记录冲突。

PR #213 审查包的全部修复、版本共存与真实运行界面前后对照见 [修复验收](../../docs/student-agent-implementation/wp04-pr213-review-fixes.md)。

完整设计与验收条目另见 [#193 设计与实施方案](../../docs/student-agent-implementation/specs/wp04-alu-board-check.md)、[工作区设计](../../docs/student-agent-implementation/wp04-193-workspace-design.md) 与 [#194 预测 / 波形引用](../../docs/student-agent-implementation/specs/wp04-alu-learning.md)。课程包可生成不代表正式运行、恢复或教学验收完成。
