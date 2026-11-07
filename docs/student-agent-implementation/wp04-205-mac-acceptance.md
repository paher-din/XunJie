# #205：Apple Silicon Mac Icarus/WASM 运行包验收

日期：2026-11-05。依据：[#205](https://github.com/paher-din/XunJie/issues/205)、[#191](https://github.com/paher-din/XunJie/issues/191) 与 [WP04 母票 #190](https://github.com/paher-din/XunJie/issues/190)。本页只记录运行包工程与真实桌面 Chrome/Worker 验收，不证明正式课程接线、学校部署或教学效果。

## 结论

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 机型、系统、Chrome、构建工具与资源身份；真实交付包与 Worker；资源来源和部署路径 | 通过 | 本页「环境与候选」「Chrome/Worker」；[适配证据](evidence/wp04-205-adapter.json) |
| 固定源码/补丁/工具链重建并核对摘要；`system.vpi`、系统任务、结束控制、诊断与真实 VCD | 通过 | 本页「重建」；[重建证据](evidence/wp04-205-rebuild.json) |
| 公开适配入口：真实 F/Cout、四态、VCD、日志、可信终止；不完整结果、Z/X、编译失败、stdout 不冒充观察 | 通过 | 适配 47 项；[适配证据](evidence/wp04-205-adapter.json) |
| 独立 oracle 4096 组（含 1536 保留组合）；丢进位 256 错误、X 1536 未知；固定原生 Icarus 规范化对照 | 通过 | 本页「工程与 oracle」；[原生证据](evidence/wp04-205-native.json) |
| 源/include/顶层/支架/选项/运行包/适配器变化的缓存命中与失效；不同输入下的真实输出 | 通过 | 适配 47 项与浏览器六模式；[适配证据](evidence/wp04-205-adapter.json) |
| 输入/内存/输出/时间/并行上限；无限推进、零时间循环、超大输出、停止/完成竞争与终止后恢复 | 通过 | 适配 47 项与浏览器六模式 |
| 加载、编译、复用执行、停止耗时；设备、负载、脱敏日志、摘要和截图 | 通过 | 本页「性能与负载」；两张截图 |

工程、真实 Chrome/Worker 与教学效果分别报告：工程与浏览器验收通过；教学效果未评估，运行包不包含正式活动接线。

## 环境与候选

| 项目 | 实际值 |
| --- | --- |
| 机型 | MacBook Air `Mac17,3`，Apple M5，10 核（4 性能 + 6 能效），16 GB |
| 系统 | macOS 27.2（build 26B123），arm64 |
| 浏览器 | Google Chrome 156.0.8078.80，真实桌面非 headless |
| 编排运行时 | Node v24.18.0（Homebrew `node@24`；仓库声明 24.21.0，本机无该补丁版本），Python 3.14.6 |
| 原生对照 | 固定源码 `c7530dbcc186de2f21eacde14fd28061b885924c` 本机构建 Icarus 14.0 (devel)；另有 Homebrew Icarus 13.0 冒烟 |
| 构建工具 | Ubuntu 24.04.5 x86_64 远程构建宿主；Emscripten 3.1.64（emsdk `0b3bcbc3b005cbb811d48e497eabcc6846d43001`，release `fd61bacaf40131f74987e649a135f1dd559aff60`）；SDK 三个 Linux x64 工具摘要见重建证据 |
| 运行包 | `components/alu-icarus-runtime`，身份 `d27007d2f8725b22fc5ff3b7f79b4179c12c103d7789c5bd318cb9be5aa86026` |
| 部署路径 | 回环静态 HTTP：运行资源 `/assets/`，适配模块 `/adapter/`；直接消费 Git 交付目录，无 CDN |
| 候选基线 | `wp04@075c2f9f0b1d7da71c45c3f9aadf0e5d1237e633`；本次验收修复后的分支头见 Issue 评论 |

资源摘要（清单 27 个文件全部复算一致，清单自身除外）：

| 资源 | SHA-256 |
| --- | --- |
| `ivl.js` | `44df0e74bccebd7b75c09723c61f58af2523c9edb54918a1950b77606ddd014f` |
| `ivl.wasm` | `4fb44c4ce552b459c99be1f870fbd0156c56db64dd72d5061d96394cd15397de` |
| `ivlpp.js` | `d9913e3c544d80d36207438b4bdbf220318c66f836a6cdd9c174d6597d382982` |
| `ivlpp.wasm` | `c0dd514775c3d6e25dfcd7c379d71194b5826702b18ecc4b3bdb3f376fbd93d3` |
| `vvp.js` | `04d4dfb6003f48eb641dfe454dd744a3e5e623e98f774e13da9853eb02f1f995` |
| `vvp.wasm` | `bd10d2dcb0ae2bf019bd4ca6a3b4a47d25b22f3f2e762a6e043a7ca7c170c430` |
| `index.mjs` | `987d50f3ea7fe1eedf3cdb5454d8cb072c7716ade362dd75ffacce24b57407b9` |
| `worker.mjs` | `a22974b2eb826796084fd1420bb69d7774b986117eb14ba1307d75b37e8cbf5d` |
| `identity.mjs` | `c3ff263a062dfcb502f620c921af70a97c597f55d6a728e6403459ea366b48da` |
| `index.d.mts` | `83b72867b72bfe8d5159a9a11e8d8ffe2cf7e5e60ce904a84e64cec29f953fb1` |
| `source/iverilog.tar.gz` | `d5e0d83f7028e2c11c127e16aaa5ab35627b1f4f62abfa982defcf77e8959bc2`（3,176,904 bytes） |

## 重建

固定交付包中的源码归档原先有 6095/6163 个文件被转成 CRLF，`autoconf.sh` 在 Unix 上无法执行，按 `source/README.md` 从归档重建会失败。已用固定 commit 的 `git archive` 重新生成 LF 归档，核对归档内容与 `c7530dbc…` 工作树逐字节一致，并更新清单摘要。

- **Mac 跨宿主复建**：同一固定源码与 Emscripten 3.1.64 在 macOS arm64 上做两次干净构建，六个资源两次完全一致；三个 `.js` 与交付包一致，三个 `.wasm` 因宿主 SDK 二进制不同而不同。该结果只作同源交叉检查，不替代交付资源。
- **固定 Linux x64 重建**：在 Ubuntu 24.04.5 x86_64 构建宿主上用锁定的 Emscripten 3.1.64 Linux x64 工具做两次干净构建。`verify-sdk.py` 核对 `clang`、`wasm-opt` 与构建 Node 摘要与锁一致；两次构建的全部六个摘要一致，并与交付包 `checksums.txt` 逐项相等。构建参数沿用 `build-port.sh`，仅把并行度从 `-j4` 降为 `-j2` 以适配 2 核宿主；不影响产物。完整日志、摘要和宿主包版本见 [重建证据](evidence/wp04-205-rebuild.json)。
- **系统模块与结束控制**：编译配置保留 `module:system.vpi`；固定支架实际调用 `$fopen`/`$fdisplay`/`$fclose`、`$dumpfile`/`$dumpvars` 与 `$finish`。4096 行观察写入隔离文件，VCD 含 `$enddefinitions` 与最终时间戳 `#4096000`，诊断为空；静态资源中也可检索到 `system.vpi` 与 `$dumpfile`。行为验证优先于字符串检查。

## 工程与 oracle

`smoke.mjs` 在 Node 中直接加载三个固定模块，三组结果的规范化行摘要与固定原生 Icarus 完全一致：

| 用例 | 向量 | 错误 | 未知 | 行摘要 |
| --- | --- | --- | --- | --- |
| 正确实现 | 4096 | 0 | 0 | `3860148aec303b9db2ca17fb388e7f444e2b59ece58bd438b13e293bf38253c5` |
| 丢进位负例 | 4096 | 256 | 0 | `f3199dca83ee0c9b2f8a781a894dcd1a5597117a4eab6d9fc6c17d7011a4be00` |
| X 保留组合负例 | 4096 | 1536 | 1536 | `5f2effbb518ac778345fa96dc5f560c0347d3912f168bd323680676264b3c48b` |

本机固定源码原生 Icarus 14.0 (devel) 的同一三组摘要分别为上述值；VCD 均含定义和最终时间戳，超时探针在约 252 ms 终止直接子进程。原生证据见 [wp04-205-native.json](evidence/wp04-205-native.json)。

## Chrome/Worker

真实桌面 Chrome 的 `browser-smoke.mjs` 六种模式通过：正确、丢进位、X、无限推进、零时间循环、停止后恢复。正确/恢复模式的 4096 行、单输入（2529/1204/2084）、VCD 与诊断均符合预期；无限推进和零时间循环由主线程实际终止，观察到约 252 ms，随后新 Worker 可正常执行。

公开适配入口在真实 Chrome Worker 中 **47 项通过**，包括：真实编译与 4096 观察、系统任务与 VCD、独立 oracle、编译复用、选项/include/源/支架/顶层失效、显式编译单元、编译失败诊断、Z 与不完整输出、stdout 不冒充观察、空预期拒绝、保留路径、零时间循环停止、墙钟预算、stdout/文件洪泛预算、输入预算（源与运行文件/数量）、并行与跨实例 busy、产物/资源/适配器身份校验、内存超限失败、失败后恢复，以及 5 次停止/完成竞争终态。停止时延约 0.1 ms。完整 47 项、时延和宿主信息见 [适配证据](evidence/wp04-205-adapter.json)。

## 性能与负载

测量为单次工程记录，不作为 SLA。设备为 MacBook Air M5 16 GB，测试时系统 1 分钟负载约 2.8–4.0，Chrome 非 headless。

| 阶段 | 耗时 |
| --- | --- |
| 资源加载（browser smoke，正确模式） | 13.4 ms |
| 预处理 | 7.8 ms |
| 编译 | 23.3 ms |
| 首次 4096 仿真 | 39.9 ms |
| 复用执行（三次） | 21.8 / 17.4 / 16.7 ms |
| 适配冷编译 / 首次仿真 / 缓存命中 | 42.3 / 49.0 / 0.2 ms |
| 复用执行（适配器） | 37.8 ms |
| 显式停止时延 | 0.1 ms |
| 墙钟终止观察（无限推进 / 零时间循环） | 251.6 / 251.5 ms（预算 250 ms 量级） |

截图：[浏览器六模式](evidence/wp04-205-browser-smoke.png)、[适配 47 项](evidence/wp04-205-adapter.png)。

## 缓存、预算与边界

- 缓存：相同编译命中；源、include、支架、顶层、选项、运行包清单和适配器身份变化均失效或拒绝；include/源变化实际改变仿真结果，支架变化实际改变日志；损坏产物与资源摘要被拒绝。
- 预算：固定文件 64/1 MiB、文本 2 MiB、单文件 8 MiB、模块累计 16 MiB、WASM 256 MiB、并行每 realm 1 个 Worker、墙钟 1–60000 ms；超限均返回可信失败/预算终态，随后正常任务可用。
- 终止：停止与完成只接受第一个终态；终止后使用新 Worker；原生内存 abort 保留实际诊断，不伪装成特定可恢复错误。
- 边界：回环静态托管只证明运行包，不证明正式宿主、学校部署、HTTPS/跨机或课程接线；不声称抵御任意恶意 HDL 的观察文件篡改；不承诺跨标签调度或跨关页继续；教学效果未评估。

## 复跑方法

在仓库根执行：

```bash
python3 tools/alu-wasm/fixture.py /absolute/fixture.json
/opt/homebrew/opt/node@24/bin/node tools/alu-wasm/smoke.mjs components/alu-icarus-runtime /absolute/fixture.json
/opt/homebrew/opt/node@24/bin/node tools/alu-wasm/browser-smoke.mjs components/alu-icarus-runtime /absolute/fixture.json /absolute/browser-output
XUNJIE_ALU_ADAPTER_ROOT=components/alu-icarus-runtime /opt/homebrew/opt/node@24/bin/node tools/alu-wasm/adapter-browser-test.mjs components/alu-icarus-runtime /absolute/fixture.json /absolute/adapter-output
PATH=/absolute/native-install/bin:$PATH python3 tools/research/probe-alu-iverilog.py --output /absolute/native.json
```

固定 Linux x64 重建：在 Ubuntu 24.04 x86_64 上安装 emsdk `0b3bcbc…` 与 Emscripten 3.1.64，按 `components/alu-icarus-runtime/source/README.md` 从归档在两个空目录执行 `port.py` 与 `build-port.sh`，比较六个摘要与包内 `checksums.txt`。本次使用远程 2 核 Ubuntu 24.04.5 宿主、`-j2`，日志与摘要见重建证据。
