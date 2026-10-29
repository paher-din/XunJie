# SystemVerilog ALU 本地执行：独立技术调查

日期：2026-10-23。范围：Windows 11 x64、Apple Silicon Mac，桌面 Chrome/Edge；4 位组合 ALU、4096 组二值输入、自选用例、F/Cout 与按需波形。即时输入反馈、预测用例点一次运行、隐藏编译装载是负责人已确认要求。本备忘录提供技术证据与验证建议，不决定产品路线。

**结论：Icarus/WASM 的 VeriSim 是最有希望的浏览器候选，已有可下载产物与实际浏览器编译、仿真、VCD 证据；还不能认定它满足课程交付。** 主线程随后完成了固定产物在 Mac 真实 Chrome 与内嵌 Chromium 中的课程 4096 组、负对照、单输入复用、Worker 停止与恢复探针，详见[运行方案与固定产物证据](2026-10-23-local-execution-proposal.md#固定-wasm-的浏览器证据)。仍需解决构建来源可复现、`system.vpi` 运行诊断，以及目标平台和产品集成验收。以下滚动部署烟测保留其原始条件，不与后续固定产物测试混为一项。

证据分级：**源码事实**为本次读取的上游固定源码/发布元数据；**实测**仅限明确注明的环境和探针；**推论/建议**不是已实现或已批准方案。2026-10-18 的执行位置研究只用于了解旧问题，未作为事实依据。

## 1. 优先交接：VeriSim / Icarus WASM

### 产物与版本

- [可直接打开的 VeriSim 演示页](https://senolgulgonul.github.io/verisim/)：本次页面显示 `v1.39`。这是滚动部署，**未校验部署文件与下列固定 commit 的二进制一致性**。
- [固定仓库快照](https://github.com/senolgulgonul/verisim/tree/dc391801af44ec8e99fcdc12c12a3d9a47a5758b)：`dc391801af44ec8e99fcdc12c12a3d9a47a5758b`，包含现成 JS/WASM，无需先安装 Emscripten 才能取用。
- [README](https://github.com/senolgulgonul/verisim/blob/dc391801af44ec8e99fcdc12c12a3d9a47a5758b/README.md) 声明基于 Icarus `14.0 (devel)`、`c7530db`；[上游完整 commit](https://github.com/steveicarus/iverilog/commit/c7530dbcc186de2f21eacde14fd28061b885924c) 为 `c7530dbcc186de2f21eacde14fd28061b885924c`。这是发布者提供的来源关系，本次未重建验证。README 的日期描述不能代替 commit 身份。

下面是**固定版本下载源**；将六个文件保持名称放到同一 HTTP 静态目录，供页面/Worker 加载。不是 npm 包安装路线。

| 阶段 | JS 模块 | WASM |
| --- | --- | --- |
| 预处理 | [ivlpp.js](https://raw.githubusercontent.com/senolgulgonul/verisim/dc391801af44ec8e99fcdc12c12a3d9a47a5758b/ivlpp.js) | [ivlpp.wasm](https://raw.githubusercontent.com/senolgulgonul/verisim/dc391801af44ec8e99fcdc12c12a3d9a47a5758b/ivlpp.wasm) |
| 编译 | [ivl.js](https://raw.githubusercontent.com/senolgulgonul/verisim/dc391801af44ec8e99fcdc12c12a3d9a47a5758b/ivl.js) | [ivl.wasm](https://raw.githubusercontent.com/senolgulgonul/verisim/dc391801af44ec8e99fcdc12c12a3d9a47a5758b/ivl.wasm) |
| 仿真 | [vvp.js](https://raw.githubusercontent.com/senolgulgonul/verisim/dc391801af44ec8e99fcdc12c12a3d9a47a5758b/vvp.js) | [vvp.wasm](https://raw.githubusercontent.com/senolgulgonul/verisim/dc391801af44ec8e99fcdc12c12a3d9a47a5758b/vvp.wasm) |

滚动部署的同名文件亦位于 `https://senolgulgonul.github.io/verisim/` 下。固定快照六文件合计 **2,994,577 bytes**，其中三个 WASM 合计 **2,701,230 bytes**，依据 [Git tree 的 blob size](https://api.github.com/repos/senolgulgonul/verisim/git/trees/dc391801af44ec8e99fcdc12c12a3d9a47a5758b?recursive=1) 求和。此数不含页面、编辑器、其他资源，不是 HTTP 压缩后的下载量或内存占用。

### 精确调用入口

**源码事实：** [index.html 的 engine 实现](https://github.com/senolgulgonul/verisim/blob/dc391801af44ec8e99fcdc12c12a3d9a47a5758b/index.html#L534-L620) 将编辑器源码写入三个独立模块的 MEMFS，执行 `ivlpp → ivl → vvp`，读取 `.vvp` 和 VCD。JS 模块的默认导出为异步工厂，提供 `FS` 与 `callMain`。这是在浏览器编译当前学生 HDL；仓库内预编译的是工具链本身。

以下摘录按上游编排整理，供主线程快速写独立探针。`designSv`、`tbSv` 为源码字符串；模块文件由同源 HTTP 服务提供。**该摘录未单独运行；本次实际运行的是上游页面的同一调用链。** 失败处理、资源预算和 Worker 终止需由探针宿主补充。

```js
import initIvlpp from './ivlpp.js';
import initIvl from './ivl.js';
import initVvp from './vvp.js';

async function compile(designSv, tbSv) {
  const preprocessed = [], diagnostics = [];
  const pp = await initIvlpp({
    print: s => preprocessed.push(s),
    printErr: s => diagnostics.push(s),
  });
  pp.FS.writeFile('/design.sv', designSv + '\n');
  pp.FS.writeFile('/tb.sv', tbSv + '\n');
  pp.callMain(['-L', '/design.sv', '/tb.sv']);
  const compiler = await initIvl({
    print: () => {}, printErr: s => diagnostics.push(s),
  });
  compiler.FS.writeFile('/ivl.conf', [
    'basedir:/', 'module:system.vpi', 'generation:2012',
    'generation:no-specify', 'out:/out.vvp', 'iwidth:32',
    'widthcap:65536', 'functor:cprop', 'functor:nodangle',
    'flag:DLL=vvp.tgt', '',
  ].join('\n'));
  compiler.FS.writeFile('/src.v', preprocessed.join('\n') + '\n');
  compiler.callMain(['-C/ivl.conf', '--', '/src.v']);
  return {program: compiler.FS.readFile('/out.vvp'), diagnostics};
}

async function simulate(program, vcdName = 'trace.vcd', dataFiles = {}) {
  const output = [];
  const runtime = await initVvp({
    print: s => output.push(s), printErr: s => output.push(s),
  });
  runtime.FS.writeFile('/sim.vvp', program);
  for (const [name, text] of Object.entries(dataFiles))
    runtime.FS.writeFile('/' + name, text);
  runtime.callMain(['/sim.vvp']);
  return {
    output: output.join('\n'),
    vcd: runtime.FS.readFile('/' + vcdName, {encoding: 'utf8'}),
  };
}
```

主线程现有探针使用 `$dumpfile("trace.vcd")`，可沿用上述默认路径；上游页面固定读取 `dump.vcd`，在演示页测试时需相应修改 testbench 的文件名。VCD 必须由 testbench 的 `$dumpfile/$dumpvars` 生成。上游 `simulate` 还会写入额外文件供 `$readmemb/$readmemh/$fopen` 使用。

### 已观察到什么，仍缺什么

- **实测：** 本次在 Codex 内嵌浏览器打开上述演示页，选择 `SystemVerilog-2012`，输入临时自编 `alu_smoke` 和 testbench。探针包含 `logic`、`assign`、`always_comb`、`case`、显式 5 位加法与 `{Cout,F}`，遍历 `A=0..15、B=0..15、selector=0..7、Cin=0..1`。其人为定义是 selector=0 做加法，其他 selector 做 XOR，**不是课程 ALU 的功能真值表**。
- **实测输出：** `SMOKE vectors=4096 errors=0`；随后注入 `A=4'bxxxx` 得到 `XPROBE F=xxxx Cout=x`；`$finish` 正常完成，VCD 下载入口出现，勾选 F/Cout 后波形可显示。这证实该部署能编译自编源码并完成这组仿真，不代表课程活动通过。
- **实测计时：** 首次点击页面报告 `preprocess=4234、compile=54497、simulate=27150、vcd-parse=20.5、total=85901`，单位 ms，VCD 约 235 KB。页面明确计入各阶段 WASM 初始化；网络、下载与计算未分离，浏览器缓存初态未控制。**不能称为标准冷启动基准，不能把 85.9 秒解释为纯编译时间，也不能承诺即时反馈。**
- **源码事实：** Icarus [四态值定义和默认 X 初始化](https://github.com/steveicarus/iverilog/blob/c7530dbcc186de2f21eacde14fd28061b885924c/vvp/vvp_net.h#L131-L251) 有 `0/1/X/Z`；本次只观察了一个 X 传播探针，未完整测试 Z、未驱动、冲突驱动、漏赋值。`-g2012` 是语言模式，不是完整 SystemVerilog 支持保证；[官方手册](https://github.com/steveicarus/iverilog/blob/dfeee909ed9f20b4870dd93423156c0170c0e1ff/driver/iverilog.man.in#L65-L78) 明示仍有大量未支持特性。
- **位宽缺口：** [Icarus 的 strict-expr-width 默认关闭](https://github.com/steveicarus/iverilog/blob/dfeee909ed9f20b4870dd93423156c0170c0e1ff/driver/iverilog.man.in#L146-L151)。VeriSim 配置未开启此项。显式位宽探针成功不能代替未定宽常量、符号扩展与截断语义验证；不同执行器需记录实际选项。
- **源码事实：** 当前 `run()` 每次新建三个模块并重新编译；`callMain()` 在页面脚本执行，未见 Worker、Stop 或外部墙钟超时。将整个计算链放入可终止 Worker 是建议，尚未验证。宿主的 [`Worker.terminate()`](https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate) 能直接停止 Worker；仅在同线程加 `setTimeout` 不能打断同步 WASM。
- **构建缺口：** README 描述静态链接 `tgt-vvp` 与 `system.vpi` 的改动，但固定仓库树只有页面、JS/WASM 等产物，未发现对应移植补丁、Emscripten 固定版本或完整构建脚本。**有现成二进制不等于已有可复现的维护链。** 还需固定产物实跑、记录 digest，并取得/复现移植构建；本次未从源码构建。
- **交互缺口：** 当前演示是编辑 testbench 后 Run。复用 `.vvp`，使用数据文件或 plusargs 提供自选输入，每次有界执行，是可验证的工程方向；尚未验证它满足已确认的即时输入反馈，也未决定采用持续会话或每次新运行时。

## 2. 次选证据：Vera / Verilator + Clang WASM

[Vera 固定 commit](https://github.com/roman01la/vera/tree/e9b70e990b0dd0d58e0e88826380ca5adf466f70)：`e9b70e990b0dd0d58e0e88826380ca5adf466f70`。[pipeline.ts](https://github.com/roman01la/vera/blob/e9b70e990b0dd0d58e0e88826380ca5adf466f70/src/pipeline/pipeline.ts#L208-L275) 实际调用浏览器 Verilator 将源码转为 C++，再经 Emception/Clang 生成并加载 WASM，确实包含浏览器编译阶段。Cloudflare [worker](https://github.com/roman01la/vera/blob/e9b70e990b0dd0d58e0e88826380ca5adf466f70/worker/index.ts) 负责资源分发与响应头。

**为何暂不优先：**

- [README](https://github.com/roman01la/vera/blob/e9b70e990b0dd0d58e0e88826380ca5adf466f70/README.md) 写 Verilator v5.046，但 git submodule 固定为 `56ed47ee7c32c00ced3586687bd2555d08db396c`，其 [configure.ac](https://github.com/verilator/verilator/blob/56ed47ee7c32c00ced3586687bd2555d08db396c/configure.ac#L15) 为 **5.047 devel**；以源码身份为准。
- [上游语义说明](https://github.com/verilator/verilator/blob/56ed47ee7c32c00ced3586687bd2555d08db396c/docs/guide/languages.rst#L253-L282) 明确主要是二态仿真，X 赋值会转为常量，不能用其正常二值输出证明学生没有产生 X。
- [Verilator Worker](https://github.com/roman01la/vera/blob/e9b70e990b0dd0d58e0e88826380ca5adf466f70/src/workers/verilator.worker.ts#L125-L144) 使用 `--no-timing`，未开启标准 `--trace`；[harness](https://github.com/roman01la/vera/blob/e9b70e990b0dd0d58e0e88826380ca5adf466f70/src/lib/harness-template.ts#L82-L186) 自行把提取的信号写成 0/1 VCD，不能直接等同于完整事件仿真与全部层级 trace。
- 有 `setSignal/step/maxCycles/pause` 接口及 [dispose→terminate](https://github.com/roman01la/vera/blob/e9b70e990b0dd0d58e0e88826380ca5adf466f70/src/pipeline/simulation-api.ts#L153-L216)。但 [运行循环](https://github.com/roman01la/vera/blob/e9b70e990b0dd0d58e0e88826380ca5adf466f70/src/workers/simulation.worker.ts#L586-L647) 在批次之间检查暂停标志；不能据此保证一次卡住的 `eval` 会及时退出。它使用 SharedArrayBuffer，部署还需 COOP/COEP。
- 有 [Verilator 构建脚本](https://github.com/roman01la/vera/blob/e9b70e990b0dd0d58e0e88826380ca5adf466f70/scripts/build-verilator-wasm.sh)，但 Emception 取用脚本指向滚动仓库/演示资源；本次没有确认一套完整、固定且可直接运行的发行产物，**未运行 Vera**。不采用 README 的性能数字作为本课程证据。

## 3. Native Icarus：已有结果与自动准备成本

**已有实测（主线程提供，本调查只读核对、未重跑）：** [探针结果](2026-10-23-alu-iverilog-probe-results.json) 与 [脚本](../../../tools/research/probe-alu-iverilog.py) 记录 Mac arm64、Icarus 13.0：4096 组零不匹配；漏进位负对照产生 256 处不匹配；X 负对照产生 1536 处未知输出；VCD 含定义及最终时间；250 ms 外部超时在约 252.481 ms 终止直接子进程。其范围明确不含 Windows、安装器、浏览器连接或沙箱验收。Icarus 13.0 的[固定源码](https://github.com/steveicarus/iverilog/tree/dfeee909ed9f20b4870dd93423156c0170c0e1ff)为 `dfeee909ed9f20b4870dd93423156c0170c0e1ff`。

**现成打包证据：** [OSS CAD Suite 2026-10-22](https://github.com/YosysHQ/oss-cad-suite-build/releases/tag/2026-10-22) 同时发布以下包；[发布 API](https://api.github.com/repos/YosysHQ/oss-cad-suite-build/releases/tags/2026-10-22) 提供大小和 SHA-256。未下载、解包或运行这些包。

| 目标 | 固定下载 | 压缩包大小 | SHA-256 |
| --- | --- | --- | --- |
| Windows x64 | [windows-x64-20261022.tgz](https://github.com/YosysHQ/oss-cad-suite-build/releases/download/2026-10-22/oss-cad-suite-windows-x64-20261022.tgz) | 604,046,688 bytes | `35fe136df7fd863d347379272a7aed7274d65b3ca5b6f45f300af7ff02435c7e` |
| macOS arm64 | [darwin-arm64-20261022.tgz](https://github.com/YosysHQ/oss-cad-suite-build/releases/download/2026-10-22/oss-cad-suite-darwin-arm64-20261022.tgz) | 526,090,289 bytes | `378e87e60db8cb3d077c63613cbed75e52306cf5ebdfeb95596629f343e536c0` |

[固定构建仓库说明](https://github.com/YosysHQ/oss-cad-suite-build/blob/cc0058b9e9f0a0301c0e8eb72f51f2200b637fe0/README.md) 列出 Icarus、Verilator 及所需共享库，声明 Windows 10/11 和 macOS 13+ arm64；这是发布方支持声明，未代替项目验收。构建 commit 为 `cc0058b9e9f0a0301c0e8eb72f51f2200b637fe0`；[Icarus 规则](https://github.com/YosysHQ/oss-cad-suite-build/blob/cc0058b9e9f0a0301c0e8eb72f51f2200b637fe0/default/rules/iverilog.py) 跟随 `origin/master`，因此不能把该每日包称为刚测过的 13.0。需从实际包取得引擎版本及源码身份。

**技术建议：可以把手工安装链转移到产品维护的安装与启动层，不能把“下载有包”写成“已免配置”。新增准备成本集中于：**

1. 按 OS/架构下载固定包、校验、解包，管理版本、失败恢复、更新和运行检测。完整套件较大；只提取 Icarus 的最小依赖包需要另做依赖闭包与两平台验证，暂无其可靠体积数据。
2. 配置进程自己的环境与运行目录。[Windows environment.bat](https://github.com/YosysHQ/oss-cad-suite-build/blob/cc0058b9e9f0a0301c0e8eb72f51f2200b637fe0/default/patches/environment.bat) 设置 `bin/lib` 等路径；Windows 安装路径含空格、中文用户名需实测。macOS 上游 [activate](https://github.com/YosysHQ/oss-cad-suite-build/blob/cc0058b9e9f0a0301c0e8eb72f51f2200b637fe0/default/patches/activate) 使用 sudo 清除 quarantine，不能算已提供无干预产品安装器；签名、分发与系统确认体验仍需完成。
3. 页面到本机执行组件的启动、检测、连接与停止。若采用 localhost 通道，[Chrome 的 LNA 文档](https://developer.chrome.com/blog/local-network-access)说明安全上下文及访问本地服务的权限；目标 Chrome/Edge 均需实际验证。若采用扩展 Native Messaging，[Chrome 文档](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)要求安装并登记 host，仍有首次引导成本。
4. Icarus 可直接复用 `.vvp`，通过 [plusargs](https://github.com/steveicarus/iverilog/blob/dfeee909ed9f20b4870dd93423156c0170c0e1ff/vvp/vvp.man.in#L74-L86)或输入文件传入用例；普通 HDL 编译运行不必引入旧自定义 VPI 链。若选 Native Verilator，学生每次改设计后的 C++ 编译/链接工具链也要由产品准备；[上游安装要求](https://github.com/verilator/verilator/blob/56ed47ee7c32c00ced3586687bd2555d08db396c/docs/guide/install.rst#L98-L126)和套件[生成 Makefile 的配置](https://github.com/YosysHQ/oss-cad-suite-build/blob/cc0058b9e9f0a0301c0e8eb72f51f2200b637fe0/default/scripts/verilator.sh)不能证明学生机器已具备这些工具。

Docker/WSL 未被排除，但本次已找到直接分发原生工具的候选，不需要先把虚拟化设为前提。若后续采用 WSL，Microsoft 的[安装说明](https://learn.microsoft.com/en-us/windows/wsl/install)仍涉及管理员安装及重启；它能统一 Linux 工具环境，不能自动消除首次准备流程。

## 4. 验证清单与交接

以下固定产物课程探针、输入复用和 Worker 终止恢复，已由主线程在 Mac 的两种 Chromium 环境执行并留下记录；构建复现、其余平台及产品集成仍未完成。

1. **固定产物烟测。** 从上述 commit 获取六文件并记录 digest，用独立 HTTP 页面/Worker 执行给出的调用链；复用主线程现有 DUT/testbench 和负对照，保存逐行 F/Cout 与 VCD。比较相同输入的实际输出，不要求不同引擎的 VCD 文件字节相等。
2. **4096 全量。** 对 `{M,S,A,B,Cin}` 的 12 位组合逐个执行，要求索引完整且无重复、无排除；旧 [contracts/runner/alu.ts](../../../apps/server/contracts/runner/alu.ts) 的 `expected:2800/excluded:1296` 及旧测试不作通过证据。本次浏览器合成探针也不作课程功能通过证据。
3. **即时反馈与预测运行。** 不改源码时复用编译产物，测量输入变更到正确 F/Cout 显示，以及预测用例点一次运行的延迟；分别记录首次加载、缓存后加载、改源码重编译和只改输入。编译装载应保持产品要求的隐藏行为。此项决定现有 WASM 引擎经适配后是否足够，当前没有结论。
4. **停止与恢复。** 在独立 Worker 中测试无限仿真和零时间死循环，由外部墙钟终止，随后能重新运行正常用例；`$finish`、模拟时间上限或合作式 pause 不能单独覆盖这两种情况。验证 X/Z、截断、漏赋值及编译诊断。Windows 11 x64 / Apple Silicon × Chrome / Edge 四格都记录准确版本；已完成的 Mac native 探针无需重复冒充新证据。

**证据边界：** 本独立调查读取固定上游源码、构建和发布元数据，完成一个滚动部署浏览器烟测，并读取主线程 Mac native 结果。主线程随后补齐的固定 WASM 自托管与有界执行记录见上述链接；移植构建复现、Windows native、自动安装更新、完整目标浏览器矩阵、产品端到端即时反馈与教学效果仍未验证。
