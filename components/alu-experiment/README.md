# 正式 ALU 虚拟板与全量检查课程包

在仓库根运行 `node components/alu-experiment/package.mjs`，生成 `dist/alu-experiment/component.json` 与 `course.json`。分别使用产品的正常组件导入和课程导入接口登记；学生从课程入口进入活动。本目录不是独立页面或测试接收器。

生成目录包含实际材料与 `runtime/` 固定资源，JSON 是 CLI 使用的相对路径清单。运行中的本机产品可用下列命令导入（`xunjie` 对应产品启动器，Windows 为 `xunjie.cmd`）：

```sh
xunjie component-import --root <环境目录> --file <绝对路径>/dist/alu-experiment/component.json
xunjie course-import --root <环境目录> --file <绝对路径>/dist/alu-experiment/course.json
```

程序化管理端调用可消费 `aluPackage()` / `aluCoursePackage()` 返回的完整 API 请求；CLI 清单不内嵌 base64，也不越出生成目录读取文件。

`alu.sv` 只有端口与 TODO；`single.sv` 为只读采样支架，t=0 设置输入、t=1ns 采样、t=2ns 结束；`check.sv` 为只读全量支架，按 `ROUND`/`SAMPLE` 对 4096 个索引施加 P0/P1 前驱并记录 F/Cout；`self-check.sv` 为独立常量探针，不是 ALU 答案。版本 2 的组件声明 `run-single`、`observe-enabled`、`check-all` 三个操作，状态只保存输入、revision 和启用/选择指针。公开控制表、虚拟板映射、4096 域、采样与检查说明见 [learning.md](learning.md)。

包固定现有 Icarus 候选的六个 JS/WASM 资源，随对应源码与许可证分发。宿主 Adapter 随产品构建，课程不能提供自己的宿主代码。运行包身份来自 [固定清单](../alu-icarus-runtime/manifest.json)，修改适配器后用 `node tools/alu-wasm/refresh-adapter.mjs` 重验六项工具资源并更新身份；不重新编译或替换已验证的工具链二进制。

完整设计与验收条目另见 [#193 设计与实施方案](../../docs/student-agent-implementation/specs/wp04-alu-board-check.md) 与 [工作区设计](../../docs/student-agent-implementation/wp04-193-workspace-design.md)。课程包可生成不代表正式运行、恢复或教学验收完成。
