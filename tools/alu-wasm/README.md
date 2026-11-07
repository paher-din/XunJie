# ALU Icarus/WASM 运行包（#191）

在浏览器 Worker 内实际预处理、编译和运行 SystemVerilog，无 React、业务 API、旧 HDL 会话或学生端原生运行依赖。只提供编译/仿真适配；业务接收、权限、持久结果和恢复继续归 WP03 所有者。正式课程与工作区接线属于后续票。

Windows 与 Apple Silicon Mac 桌面 Chrome 均已验证，Mac 结果见 [Apple Silicon 验收记录](../../docs/student-agent-implementation/wp04-205-mac-acceptance.md)。工程仿真不证明教学效果。

## 固定构建

使用 Ubuntu 24.04 Linux x64。[工具链锁](toolchain.lock.json)固定 Icarus/Emsdk commit、Emscripten 3.1.64 及实际编译器/优化器/构建 Node 摘要；[宿主包锁](ubuntu-packages.lock)记录精确环境版本。SDK 自带 Node 只供构建，项目仍使用规定的 Node 24.21.0。

运行 `bash tools/alu-wasm/doctor.sh` 只读检查依赖。缺少依赖时由本人在 Ubuntu 执行：

```bash
sudo apt-get update
sudo apt-get install -y build-essential autoconf automake gperf bison flex cmake ninja-build pkg-config zlib1g-dev libbz2-dev
```

取得锁定的 Icarus 与 Emsdk commit，在 SDK 目录执行 `./emsdk install 3.1.64`、`./emsdk activate 3.1.64`。SDK 与源码放在 Linux 用户专用缓存，避免 Windows 挂载盘小文件开销；无需修改全局 shell 配置。安装方法见 [Emscripten 官方说明](https://emscripten.org/docs/getting_started/downloads.html)。

```bash
bash tools/alu-wasm/rebuild.sh /absolute/icarus-git /absolute/emsdk /absolute/new-build-root /absolute/new-output-root
```

两个输出根目录须不存在；脚本不删除调用者数据。先核对环境，再从两个空源码目录分别导出固定 commit、应用 [移植程序](port.py)、完整构建，并比较全部六个 JS/WASM 摘要。不一致直接失败。构建固定 C locale、UTC、SOURCE_DATE_EPOCH=0、安装前缀 `/runtime` 和全部选项，不注入当前时间。本轮双干净构建已逐字节一致。

移植保留编译器系统函数类型注册和 VVP 实际任务注册，静态链接上游系统模块及 VVP 目标。保留 `module:system.vpi` 声明，未知模块继续拒绝，不过滤诊断。另修正可执行后缀和本机代码生成器误继承 WASM 链接参数的问题。源码上下文变化会失败；每次应用必须用干净源码。

## 生成交付包

用项目 Node 在仓库根执行：

```bash
node tools/alu-wasm/pack.mjs /output/a /output/b /icarus-git /absolute/new-package /absolute/emsdk
```

目标须为新目录。可直接消费的固定候选位于 `components/alu-icarus-runtime`，随 Git 分支共享。打包再次比较双构建的实际字节，交付六个工具链资源、适配模块与类型、摘要清单、对应 Icarus 源码归档、显式补丁、重建工具及上游许可证，并保留 Emscripten、libc++/libc++abi、compiler-rt 和 musl 的随包声明。没有运行时 CDN 依赖。分发保留对应源码和许可证；包内 `source/README.md` 可从自带源码重建。构建缓存和验证现场不进入 Git。

整个输出目录按原相对路径同源静态托管，JS/MJS 使用 JavaScript MIME、WASM 使用 `application/wasm`。需要允许本包 Worker 及经摘要校验的 Blob 模块；不需要 SharedArrayBuffer 或跨源隔离。正式宿主仍须在执行包代码前按自己的资源授权/摘要机制准备固定版本。

## 公开入口

```js
import { createIcarusRuntime } from '/alu-runtime/index.mjs';
const manifest = await (await fetch('/alu-runtime/manifest.json')).json();
const runtime = await createIcarusRuntime({
  identity: manifest.identity, assets: manifest.assets, adapters: manifest.adapters,
  baseUrl: new URL('/alu-runtime/', location.href).href,
});
const compiled = await runtime.compile({
  top: 'tb', sources: [
    { path: 'design.sv', content: fixedDesign },
    { path: 'tb.sv', content: fixedHarness },
  ], options: { includeDirs: [], strictExprWidth: false },
});
if (compiled.status === 'completed') {
  const observation = await runtime.simulate({
    artifact: compiled.artifact, files: [], plusargs: ['+CASE=2529'],
    expectedIndices: [2529],
  }, { timeoutMs: 5000, signal: abortController.signal });
}
```

默认按声明顺序编译 `.sv`/`.v`，也可用 `entryFiles` 明确编译单元及顺序，使 `.v` include 文件只作依赖。include 文件也在固定集合中；禁止绝对路径、`..`、重名及保留路径 `pp.conf`。顶层/支架属于固定源输入。支持的选项如示例，未知选项拒绝，不开放任意编译器配置。运行输入为固定文件和 `+NAME=value`，`sim.vvp`、`trace.vcd`、`xunjie-observations.txt` 保留。固定支架以 `$fopen("xunjie-observations.txt", "w")`、`$fdisplay` 写入 `ROW <索引> <四位01xz> <一位01xz>`，结束前 `$fclose`；普通 stdout 仅作日志。VCD 由真实 `$dumpfile("trace.vcd")`/`$dumpvars` 生成。该文件隔离普通 stdout，不构成对任意恶意 HDL 的防篡改证明；调用方负责固定受信支架和作品归属。

结果包含原始诊断、日志、VCD/缺失、四态观察、编译依赖及运行包身份。退出成功与观察完整性分开：提供非空预期索引且完整按序取得结果才报告 `complete`/`complete-with-unknown`；空预期被拒绝，缺失、不完整和未承诺覆盖分别表达，不把 X/Z 当零。

编译身份覆盖全部源/include 路径与内容、顶层及支架、选项、固定编译配置，以及工具链和四个适配器资源的摘要。只复用完全匹配的产物。缓存可丢弃，最多 8 项/32 MiB，不保存学习结果；返回与缓存使用独立副本，重用时核对所属运行包和程序摘要。

## 预算与终止

| 资源 | 上限 |
| --- | --- |
| 固定源或运行输入 | 每次 64 文件、合计 UTF-8 1 MiB |
| 标准输出及诊断 | 每次合计 2 MiB |
| 文件写入 | 单文件 extent 8 MiB，每模块累计 extent 高水位 16 MiB；包含输入/程序写入 |
| WASM 内存 | 每模块 256 MiB；编译两个独立模块，仿真一个；不冒称 Chrome/JS 宿主内存硬上限 |
| 并行 | 同一模块的浏览器 realm 最多一个活动 Worker；跨适配器实例也返回 busy，不宣称跨标签调度 |
| 时间 | 默认编译 30 秒、仿真 5 秒，可选 1–60000 ms；不承诺精确墙钟停止 |

主线程持有终止权，AbortSignal/超时实际终止 Worker，只接受第一个完成/停止终态。输出越界直接通知主线程再终止，避免原生层吞掉异常继续循环。新任务使用新 Worker，不承诺跨关页继续。内存耗尽保留实际失败/诊断，不把无法确认原因的原生 abort 冒称为某种特定可恢复错误。

0.3.1 在 stdout/stderr 写入 TTY 行缓存之前累计原始字节，无换行 `$write` 同样受合计 2 MiB 上限约束；解码后的回调不重复计数。失败与输出超限返回中保留已经写入的有界 stdout/stderr，包括 `$fatal` 的文件位置、消息和时间。产品将单次运行及各轮检查日志作为原执行资源保留。

适配层更新使用 `node tools/alu-wasm/refresh-adapter.mjs <new-version>`。命令先按原清单核验并保留完整旧包，再生成新摘要；已有快照不允许覆盖为不同字节。当前产品同时登记 0.3.0 与 0.3.1，新活动消费新身份，旧活动继续运行自己的固定包。

## 复跑验证

在仓库根生成工程夹具，不加入学生起始作品：

```bash
python3 tools/alu-wasm/fixture.py /absolute/fixture.json
node tools/alu-wasm/smoke.mjs components/alu-icarus-runtime /absolute/fixture.json
node tools/alu-wasm/browser-smoke.mjs components/alu-icarus-runtime /absolute/fixture.json /absolute/probe-output
XUNJIE_ALU_ADAPTER_ROOT=components/alu-icarus-runtime node tools/alu-wasm/adapter-browser-test.mjs components/alu-icarus-runtime /absolute/fixture.json /absolute/adapter-output
```

PowerShell 使用 `$env:XUNJIE_ALU_ADAPTER_ROOT='components/alu-icarus-runtime'`。浏览器脚本启动已安装的桌面 Chrome；回环 HTTP 仅证明运行包，不是正式产品或学校部署验收。Node 烟测有 Worker 全局工程垫片，真实 Chrome 验证无该垫片。

固定正确实现覆盖 4096 组（含 1536 保留组合），进位负例 256 错误、X 负例 1536 未知，与固定源码原生 Icarus 比较规范化摘要。公开适配另验 include 真实影响、缓存失效、编译失败、Z、不完整输出、资源摘要、输入/输出/内存/并行/时间预算、停止竞争及失败后正常任务。Apple Silicon Mac 的真实 Chrome/Worker 复跑结果与命令见 [Mac 验收记录](../../docs/student-agent-implementation/wp04-205-mac-acceptance.md)。原始失败与最终边界见 [交付记录](../../docs/student-agent-implementation/wp04-191-runtime-plan.md)。
