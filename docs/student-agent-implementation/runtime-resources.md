# 产品分发候选资源

本页记录 issue #143 的构建候选，不代表安装、原生进程、备份升级、签名或教学效果验收通过。固定资源见 [product-resources.json](../../scripts/product-resources.json)，构建入口见 [package-product.mjs](../../scripts/package-product.mjs)。不采用缺备份升级工具的精简包，也不回退宿主 PostgreSQL 或 Node。

## 固定版本与来源

PostgreSQL engine 为 **18.6**，theseus 分发版本为 **18.6.1**；最后一位是打包修订，不是数据库 minor。[上游 release](https://github.com/theseus-rs/postgresql-binaries/releases/tag/18.6.1) 的 archive SHA256 和大小已核实，三平台分别采用 `aarch64-apple-darwin.tar.gz`、`x86_64-pc-windows-msvc.zip`、`x86_64-unknown-linux-gnu.tar.gz`。确切 URL、字节数和摘要均在资源清单中；URL 追加 `.sha256`、`.manifest.json`、`.spdx.json` 可定位上游校验、逐文件清单与 SBOM。[来源验证说明](https://github.com/theseus-rs/postgresql-binaries/blob/main/docs/provenance.md)

Windows 分发在每个 PostgreSQL `.exe` 旁增加 `UTF-8` 进程 manifest，源文件为 [windows-postgres.manifest](../../scripts/windows-postgres.manifest)。固定上游工具没有嵌入 manifest；此附加文件由 Windows 在进程启动时读取，使中文安装/数据路径使用一致编码，保留 UTF8 数据库与 `C` collation，不修改上游 `.exe` 字节或系统代码页。来源为 [Microsoft 进程代码页说明](https://learn.microsoft.com/en-us/windows/apps/design/globalizing/use-utf8-code-page)。`distribution.json` 的 PostgreSQL 资源记录新增文件列表及逐文件摘要，上游 archive 摘要继续对应原始下载。Windows 启动参数使用实际空值关闭 Unix socket；运行管理以 `pg_ctl -w` 的退出结果完成启动检查，并释放其输出管道，避免已启动的 PostgreSQL 继承句柄导致等待服务退出。

Node.js 固定 **24.21.0**，使用官方 darwin-arm64 tar.gz、win-x64 zip、linux-x64 tar.xz；摘要逐项取自 [官方 SHASUMS256.txt](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt)。资源清单同时保留签名清单来源；本构建器校验固定摘要，不将摘要校验冒充 GPG、Authenticode 或公证验证。

PostgreSQL 完整目录保留 `LICENSE`、`dependency-notices/`、运行库、扩展、share 数据和构建来源记录。其主体适用 [PostgreSQL License](https://www.postgresql.org/about/licence/)，整包还包括 GPL/LGPL 等第三方组件，不能把整包标为仅 PostgreSQL License；再分发须处理对应 notices 和源码义务。Node 在完整上游 archive 校验与解包后，仅保留实际 Node 执行文件及完整 [LICENSE 与第三方条款](https://github.com/nodejs/node/blob/v24.21.0/LICENSE)，不携带 npm、npx、headers、tests 和其他文档；不修改保留文件的内容。`distribution.json` 明确记录此受控子集及保留路径。bundle 的 npm 依赖另收集至 `app/licenses/` 和 `app/licenses.json`。

| 产品目标 | 当前先决条件与未完成项 |
| --- | --- |
| darwin-arm64 | theseus 基线 macOS 15.0+、Apple Silicon；Mac 包七项基础工具实际 `--version` 返回 18.6，`postgres` 仅 ad-hoc 签名，无 TeamIdentifier。当前产品输出 unsigned；签名、公证按用户要求暂不做，不作为本轮构建阻塞，Gatekeeper 未验收。 |
| win32-x64 | Windows 11 x64 为产品验收目标；实机 build 26200、非提升令牌已通过 r3 独立包验收，当时 VC++ 14.50.35719 的 vcruntime/msvcp 从 System32 加载。上游未随包携带 VC++ v14 Runtime。产品仅在 managed PG 路径检测依赖，并从微软固定内容地址下载 14.51.36247.0 安装器，校验 SHA-256 与 Microsoft Authenticode；缺项/旧版返回 `installation-required` 和安装入口，许可/UAC由本人完成后重试。未将微软安装器或 DLL 字节再分发进产品包。随后实际运行微软安装器升级至 14.51，r5 非提升安装、启动和 ready 已通过；安装器返回 3010 要求稍后重启，宿主未重启。[实测范围](evidence/wp01-clean-windows.json) |
| linux-x64 | 首个实际学校组合为 Ubuntu 24.04.5 x64、glibc 2.39；独立包运行、Mac 到学校的真实公网 HTTPS 认证/重连/撤销已验证，结果见[运行证据](evidence/wp01-network-macos-linux.json)。上游 archive 的 ABI 下限仍为 glibc >=2.36 与对应 ELF loader，不是 musl 包。Node 还要求 kernel >=4.18。 |

以上平台边界以 [theseus 支持策略](https://github.com/theseus-rs/postgresql-binaries/blob/main/docs/support-policy.md) 及 [Node 24.21.0 平台说明](https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md) 为依据。

## 构建与目录布局

在已安装仓库依赖的工作树中执行；构建 Node 由当前 PATH 提供。`--help` 只显示参数，不下载、不构建。

```sh
node scripts/package-product.mjs --help
node scripts/package-product.mjs --platform darwin-arm64
node scripts/package-product.mjs --platform win32-x64 --cache /outside/resource-cache --out /outside/windows-candidate
node scripts/package-product.mjs --platform linux-x64 --profile remote --out /outside/remote-candidate
```

默认输出根目录 `dist/product-<platform>`，默认 cache 为用户目录 `.cache/xunjie-product-runtime`。输出目录必须不存在，以免覆盖并行构建或旧候选。完整包为默认 `--profile full`；`remote` 不下载、不解包 PG，且 `resources.json` 省略 PG 字段。远端组合仍含包内 Node、产品 CLI/daemon 与网页；运行时应选择 remote profile 或显式外部数据库配置，不能借此宣称已经交付学校登录和课程功能。

每次命中缓存都重新核对原始 archive 的大小与 SHA256；失败立即拒绝，不使用旧解压目录，不回退系统可执行文件。新下载先写独立临时文件，摘要通过后才进入 archive 缓存、随后解包。`tar` 保留 symlink；macOS/Linux 处理 Windows ZIP 时使用系统 `unzip`，Windows 构建使用系统 `tar`。这些仅为构建依赖，产品运行不调用它们。已核实的 Mac archive 可复用此前来源调查的缓存；缓存里的旧解压目录不参与构建。

CLI 和 daemon 从生产源码分别经 esbuild 打包为 `app/cli.js`、`app/daemon.js`；关闭 source map，不拆共享 chunk，保留 `new URL('./daemon.js', import.meta.url)` 的相邻文件约定。所有 npm/workspace 模块进入 bundle，只 external Node builtins；固定 `pg@8.16.3`，用 `createRequire` shim 兼容其 CJS 路径，禁用 native/Cloudflare 可选入口。metafile 检查禁止 test/tests/fixtures、验收宿主、非产品工程和非 builtin external，并检查输出不含原工作树绝对路径。

每次打包先创建独立 staging，再无条件执行 `npm run build:runtime -w @xunjie/web -- --outDir <本次 staging/web 绝对路径>`，直接生成本次 `web/` 并遍历验证；不读取、复制或清空共享的 `apps/web/dist-runtime`，避免多平台构建与根 verify 争用产物。存在旧 `index.html` 不会跳过构建，构建失败或未生成入口则停止打包并清理本次 staging。调用优先使用 `process.env.npm_execpath`，其余沿用平台对应的 npm 分支。原生资源分别放在 `resources/node/`、`resources/postgres/`。根目录 `resources.json` 的 `nodePath`、`postgresBin`、`webRoot` 均相对该文件，版本为 Node 24.21.0、PG engine 18.6。根目录 `xunjie`（可执行 sh）或 `xunjie.cmd` 始终调用包内 Node 与 `app/cli.js`；无参数时自动执行 `launch`，有参数时原样透传，不查找宿主 Node。Mac 根目录还输出同样行为、可双击的 `循阶.command`，与 `xunjie` 脚本内容相同且具有执行权限。不生成 `.app`。

`distribution.json` 保存平台、profile、unsigned-candidate 状态、原始 archive URL/摘要/校验清单与上游 manifest 来源、Node 受控子集与 PG 完整保留方式、许可与先决条件、npm 依赖及 notices、原生工具 entry hash、程序/网页/全部启动入口 hash 和资源清单 hash。它记录本次构建自身的检查结果，原生进程和备份升级为 `not-run`（外部探针结果另行记录）；干净 OS 虚拟机验收已按本轮范围变更取消；签名和公证为 `deferred-by-user`，不阻塞本轮构建。它不是签名的更新清单。输出目录仅在构建成功后发布，失败会移除本次 staging。

## 后续真实探针

主 agent 使用最终实际分发目录验证安装与进程管理、正常退出/强杀恢复、dump/restore 往返和维护工具。构建器只核对资源完整性，不初始化或启动数据库、不替代上述探针。

已有同平台资源支持拟验证的 **17.10 →17.11 minor**（[17.10.1](https://github.com/theseus-rs/postgresql-binaries/releases/tag/17.10.1) →[17.11.1](https://github.com/theseus-rs/postgresql-binaries/releases/tag/17.11.1)）及 **17 →18 major**（17.11.1 →18.6.1）；17.11.1 三平台 manifest 已核对基础七工具。额外升级源包不随本构建器默认分发，需另行固定与校验，不能把 18.6.1 同时当作旧版和新版。PG18 的前一 minor 与 PG19 三平台资源未完成核实，不宣称这两条路径通过。
