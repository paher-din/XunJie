# WP07 Windows 工程检查修复

负责人要求处理 [#204 交付](wp07-204-conversation-recovery.md) 后剩余的 20 个未通过工程调度项，修复后重新验收，继续提交到 `wp07`，不创建 PR。固定比较点为 `923d50a2fd2d24c244ccfc021c9e4a8b3616267a`；原始失败及此前两项复验保持在[原证据](evidence/wp07-204/verification.json)，不改写历史结果。

## 范围与验证接口

沿用这 20 项已有的公开接口：加密备份/隔离还原、源码复现包的采集和恢复、真实 HTTPS 设备证明和成员授权、本机 HTTP 控制、实际发布工作流脚本及开发环境切换。操作系统权限、外部 API 和原回执时点可作为受控边界；生产 owner、权限校验和存储实现继续实际运行。

本轮选择由失败证据确定：生产 owner 控制保留 Unix 套接字，在已有 Ubuntu 验收权限与生命周期；Windows 业务集成用可信代码注入真实 HTTP 管道作为操作系统适配，不代表 Windows 生产 owner 权限验收。适配入口不接受网络请求或配置正文选择。备份使用本机路径解析和私有目录；容量测试通过正式私有文件接口创建合成输入；测试密码运行时生成；网关等待实际页面就绪。发布测试在 Git for Windows Bash 中执行原脚本，只替换外部 GitHub API，不执行真实发布。Linux 云主机部署用例在 Ubuntu 运行，不将 Windows 跳过计为通过。

负责人另行允许开启 Windows 开发者模式，实际创建文件软链后再运行原安全断言。设置原值及恢复脚本留在本机 `.verification/wp07-engineering/`。工程验收使用仓库外的独立临时目录，避免 Node 的父目录查找意外复用工作区依赖或 Git 根；这是测试环境条件，不放宽生产检查。

## 修复内容

| 触发条件 | 修复与边界 |
| --- | --- |
| Windows 文件软链不可创建，安全用例在检查前失败 | 按负责人明确授权开启开发者模式，保留原始软链、外来文件与目录保护断言；不把无法创建软链视为通过。 |
| 备份路径、归档清单及服务快照沿用 POSIX 路径假设 | 使用平台路径 API 识别文件名和直接子路径；归档仍使用安全相对路径，识别 CRLF 清单。Windows 写明文暂存/恢复载荷前先保护自有目录，复制凭据使用正式私有文件写入接口。 |
| Linux owner 套接字被 Windows 业务集成夹具直接使用 | 生产默认 Unix 控制不变；服务工厂允许可信代码装配本地端点。Windows 测试注入真实 HTTP 管道，仍实际经过服务的启动/关闭、HTTPS、proof、SQLite 与授权。Unix 权限、竞争 owner、崩溃恢复及未启动对象关闭在 Ubuntu 实测。 |
| 网关 API 已健康，页面仍返回初始化错误 | 发布入口就绪前同时等待实际页面响应；证书生命周期夹具持续更新真实连接心跳，保留重载与已有会话断言。 |
| 容量测试用普通写入伪装 Windows 私有文件；源码出现固定测试密码 | 夹具使用正式私有 JSON 接口；测试密码运行时随机生成，不修改源码共享包的密钥扫描规则。 |
| 发布夹具误用 WSL 启动器或 Windows 原生命令无法执行 shell 脚本 | 明确使用已有 Git for Windows Bash，执行原发布脚本；仅外部 GitHub API 为受控替身，本地 Git 操作实际执行，不进行真实发布。Linux 主机部署用例明确限定 Linux 并在 Ubuntu 执行。 |
| Windows 构建票据替换被短暂文件占用拒绝 | 仅对 Windows 的 EPERM/EACCES/EBUSY 做最多约 500 毫秒的原子替换重试；不删除旧票据，不改变活 owner 与锁竞争规则。 |
| 真实权限检查超过测试邀请/夹具时限，清理失败遗留监听 | 调整合成邀请与测试准备等待；生产邀请、challenge、API 截止和明确过期拒绝断言不变。自有临时目录删除允许有限重试，恢复夹具先关闭全部监听再删除目录，关闭错误仍报失败。 |
| 锁竞争夹具暂停 HTTP 下载，再等待慢速权限检查，触发正确的传输超时 | 改为两阶段真实锁交叉验证：公共下载持锁时，由预热子进程探测同一永久 mutex；下载完成后，子进程持锁，公共下载和缓存清理均须拒绝。核对锁文件身份及释放后的公共缓存命中；不延长产品 30/60 秒传输截止。失败时等待子进程真正关闭后再清理。 |

## 验收环境与记录口径

完整检查使用从已提交源码建立的独立副本，各自执行 `npm ci`；Windows 工作区依赖没有重装。使用项目要求的 Node 24.21.0，构建可命中内容缓存，测试结果不缓存。调度项与用例数分别记录：Web 整组占一个调度项，平台跳过不算用例通过。

Ubuntu 首轮观察到时钟回退：60 秒内一次回退 3518 毫秒，而单次采样的单调时钟只前进约 1.17 毫秒；系统日志同时存在 NTP 联系成功时的倒序时间。证书和会话的零星拒绝与该现象相符，这是环境原因的推断。Microsoft 的 [WSL 时钟议题](https://github.com/microsoft/WSL/issues/11790) 有相同类型报告。临时停止 Ubuntu 的 `systemd-timesyncd` 后，60 秒观察未再回退；生产 TLS、CA 和会话时间校验保持原样。最终完整检查连续观察时钟，验收后恢复原服务状态；实际结果在下节登记。

较早 Ubuntu 副本位于 `/tmp`，整批结束后该目录已消失，后续改为 `/var/tmp` 专用目录，并在脚本退出前复制摘要及原始日志。本机已结束的失败、未完成尝试和后续复验分别记录，不覆盖原 #204 的 145/22 结果，也不把补验后的覆盖说成首轮整批全绿。

## 工程检查

Ubuntu 最终完整检查固定在 `1a7e53e47d20cc7a5641fb0fd33c6cfa1d905ea2`，**168/168 个调度项通过，退出码 0**，各项均已调度并结束，结果不缓存；Node 及 Python 的平台跳过分别保留，不与调度项相加。随后仅修改直传锁测试的协调与清理，最终代码版本为 `58a229a1`；该版本在独立 Ubuntu 源码导出副本重新运行完整直传文件，**29/29 项通过、0 跳过、正常退出**。Windows 首轮 **160 通过、8 失败**，退出码 1，原始结果保留：恢复文件因清理错误遗留监听而终止；直传文件在串行执行 10 个用例后转为四组完整复验。后续定向检查与分组结果单独列出，不把首轮描述为全绿。

Windows 后续完整文件复验：团队基线 13 项通过、0 跳过；接入客户端 16 项通过、1 项 POSIX 跳过；恢复 47 项通过、0 跳过且正常退出；构建 20 项通过、1 项原平台跳过。调度器、运行环境删除生命周期、HTTPS 成员接入及文件授权整文件均通过。直传的 29 个既有顶层用例按名字完整分配四组，使用真实文件/权限/TLS；原分组记录为 26 通过、1 失败、2 项 POSIX 跳过。锁测试改为上述交叉验证后，在 `58a229a1` 单独复验 1/1 通过，正常退出。合并逐项覆盖为 **27 通过、2 跳过、0 未解决**，所有分组正常结束，没有使用 Node 强制退出选项；不将它称为 Windows 单进程整文件通过。

原 20 项均已解决；Windows 首轮其余失败也已由后续文件复验覆盖。逐项任务、分组名字、原始失败、补验、源码来源和日志摘要见[机器记录](evidence/wp07-engineering/verification.json)。Windows 首轮从 `578a2914` 准备副本，在安装依赖期间更新到 `ec66c6a8` 后启动检查；根工作区七任务补验从 `3fe50329` 开始，期间三个提交只调整测试夹具，基线的等待调整在该文件启动前已提交。首轮和七任务批次未捕获逐任务源码 hash，这一证据粒度在机器记录中保留；直传最终补验有精确源码及日志摘要。

| 原 20 个调度项 | Windows 最终复验 | Ubuntu 最终完整检查 |
| --- | --- | --- |
| [保留备份](../../tools/i0-cloud/backup-retained.test.mjs) | 通过 | 通过 |
| [运行包构建](../../tools/i0-cloud/build-runtime-artifact.test.mjs) | 通过 | 通过 |
| [容量失败边界](../../tools/i0-cloud/capacity-run-failure.test.mjs) | 通过 | 通过 |
| [发布与 Linux 部署脚本](../../tools/i0-cloud/deploy-artifact.test.py) | 发布用例通过；33 项 Linux 主机用例跳过 | 34 项通过 |
| [文件授权服务](../../tools/xj-dev-access/package-service.test.mjs) | 通过 | 通过 |
| [恢复文件安全](../../packages/product-runtime/test/recovery-files.test.mjs) | 通过 | 通过 |
| [HTTPS 接入服务](../../tools/xj-dev-access/server.test.mjs) | 通过 | 通过 |
| [团队固定基线](../../tools/xj-dev/tests/baseline-team.test.mjs) | 通过 | 通过 |
| [资源文件存储](../../packages/storage/test/blobs.test.mjs) | 通过，保留平台跳过 | 通过 |
| [成员接入客户端](../../tools/xj-dev/tests/enrollment-client.test.mjs) | 16 项通过，1 项 POSIX 跳过 | 通过 |
| [接入协议](../../tools/xj-dev/tests/enrollment-protocol.test.mjs) | 通过 | 通过 |
| [SSH 设备证明](../../tools/xj-dev/tests/enrollment-ssh.test.mjs) | 通过 | 通过 |
| [网关证书生命周期](../../tools/xj-dev/tests/gateway-certificate-lifecycle.test.mjs) | 通过 | 通过 |
| [团队直传与缓存](../../tools/xj-dev/tests/package-transfer.test.mjs) | 逐项覆盖 27 通过、2 项 POSIX 跳过 | 最终源码整文件 29/29 通过 |
| [完整业务复现](../../tools/xj-dev/tests/repro-e2e.test.mjs) | 通过 | 通过 |
| [复现包恢复](../../tools/xj-dev/tests/repro-restore.test.mjs) | 通过 | 通过 |
| [复现包敏感内容](../../tools/xj-dev/tests/repro-secrets.test.mjs) | 通过 | 通过 |
| [复现包接口](../../tools/xj-dev/tests/repro.test.mjs) | 通过 | 通过 |
| [本地账号控制业务](../../apps/server/tests/account-control.test.ts) | 真实管道 OS 适配下通过 | 默认 Unix 端点通过 |
| [应用数据库文件边界](../../apps/server/tests/application-database.test.ts) | 通过 | 通过 |

Unix owner 的竞争、失败关闭、同一 Server 误用、崩溃后继任，以及接入/应用两个实际进程的端点生命周期均由 Ubuntu 检查覆盖；Windows 的测试管道没有被记为生产 owner 权限通过。独立部署包从实际提交导出后，在仓库外加载服务与管理客户端入口通过。

最终 Ubuntu 批次初段因虚拟机重启自动恢复校时服务，连续观察记录三次回退。`07:38 UTC` 再次停止该服务后的观测没有新增回退；完整批次正常结束后，已恢复原 `active/enabled` 状态。Ubuntu 的专用目录已清理，回收约 1.07 GiB；原发行版与系统工具保留。

Windows 全部分组和补验结束、日志归档后，经进程核对清理本轮专用临时目录及直传工作树。共享依赖链接先解除，再删除测试副本；其他三个既有工作树逐一核对保留，原开发进程仍在。最终 Ubuntu 直传补验副本也已清理，校时服务再次核实为 `active/enabled`。

## 浏览器与教学效果

本地专用实例的正式 `up/status` 返回页面及 API 均就绪，随后通过正式 `down/delete` 停止并删除测试载荷。已启动现有桌面 Google Chrome 157，但自动化工具在读取窗口时无法可靠确认当前网址并停止操作，页面未实际观察，**Chrome 本轮验收未完成**。没有继续发送浏览器输入，也未将 CLI HTTPS 探活当成 Chrome 通过。

本轮没有页面设计改动。真实教学效果未评估。Apple Silicon Mac 和真实跨机未执行，仍按已有交接票 [#212](https://github.com/paher-din/XunJie/issues/212) 由持有环境的人验收，本轮未搭建 Mac 环境。

## 复跑与本机证据

完整入口为 `node scripts/verify.mjs --jobs 2`，使用独立源码及自己的依赖安装；Windows 的 `TEMP/TMP` 指向仓库外的专用目录。不能将一个测试文件中仍在运行或因平台跳过的用例计为通过。原始批次、定向复验、直传分组清单及本机恢复脚本保存在忽略目录 `.verification/wp07-engineering/`。

Windows 开发者模式按负责人授权保持开启；原属性不存在，恢复脚本为该目录的 `developer-mode.ps1 -Restore`。`.agents/skills/` 及本机验收目录均不进入 Git。提交只包含修复、测试夹具与报告，不创建 PR。
