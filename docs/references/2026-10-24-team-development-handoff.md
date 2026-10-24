# 团队开发当前交接入口

2026-10-24。本页记录本轮数据承接、成员入口与恢复线索；日常状态仍以 `xj-dev status`、实际 unit 和在线目录为准。当前交付分支为 `codex/development-collaboration-integration`，尚未合入 main。

## 服务与数据

| 单元 | 当前用途与状态 |
| --- | --- |
| `xunjie-candidate-128.service` | 唯一常驻共享业务，运行已验证的 `e03a3c9` 产物；技术名保留兼容现有接入与系统策略 |
| `xunjie-dev-access-candidate129.service` | 成员邀请、设备权限、团队目录和私有 OSS 授权；接入源码为 `dad6a9f` |
| `xunjie-shared.service` | 原 `d07dc33` 业务已停止并禁用，原库、配置和恢复材料保留作回退 |
| `xunjie-release-deploy.timer` | 已停止并禁用，避免旧发布流程重新启动原业务 |
| 日/周备份、健康监控 timer | 保持启用；监控已指向现行业务，实际 CMS 上报成功，页面与静态资源摘要匹配 |

现行配置为 `/var/lib/xunjie/team-development/application-v1.json`，业务库为 `/var/lib/xunjie/retained-tmp/xunjie-a12-completion-team20261024/synthetic.sqlite`。路径保留当前宿主的兼容约束，不代表临时数据可以删除。静态资源通过 `/opt/xunjie/development-current` 指向 `/opt/xunjie/candidates/133-e03a3c9`，监控与运行进程核对同一份产物。

共享数据取自原业务，经 SQLite Backup API 承接并在启动前核对完整逻辑内容摘要：4 门课程、27 条任务分配、9 个 attempt、14 份快照、3 条提交及4条反馈。原个人模型 store/key 配对复制到 `/var/lib/xunjie/team-development/personal-agent`，保留3项模型凭据。本轮没有重新执行模型调用或真实节点运行。动态成员接入会另增受管身份；上述数字是原业务内容范围，不是永久账号总数。

此前容量验收产生的232条提交等记录已退出活动共享库，旧现场保留在回退材料与切换前加密备份中。原正式库仍位于 `/var/lib/xunjie/retained-tmp/xunjie-a12-completion-dZlbr9/synthetic.sqlite`，原服务不会自动启动。

## 固定团队起点

| 字段 | 已发布值 |
| --- | --- |
| name / version | `team-demo` / `2026-10-24-v1` |
| 稳定编号 | `xjp_6ed0ba88-58de-4a26-89da-49066f454796` |
| 完整摘要 | `sha256:df1cb8f50c611e97171d7fb6da434d7f0e645217af92579beee7375b5caa1f9a` |
| ZIP 大小 | 6,469,968 bytes |
| 包内源码来源 | `28919b88f39f1034b280ad6fa2026ae0ea380bdc`，852个明确选定文件 |
| 数据范围 | 原4门课程、全部27条任务分配、9个attempt、14份快照、3条提交、4条反馈；11个独立本地测试身份 |

包已上传私有 OSS、登记为固定目录条目，并通过公开 CLI 在负责人 Mac 的当前工作树执行 `--here` 导入成功，未替换源码。18条尚未开始的任务通过显式 `data.includeUnstartedAssignments: true` 保留；普通复现采集仍只包含明确选定的 attempt。原密码、登录会话、模型凭据、机器连接与浏览器身份不进入该包，恢复时重新生成本地密码。

Agent 按[数据基线](../development-tooling.md#获取与更新数据基线)在线核对条目，再采用固定版本。已有环境保持数据，需要另一版本时另建隔离副本。团队目录中的 `acceptance-conflict / 0.2.0-20261024` 是历史交接验收场景，不是本轮默认起点。

内置 `local-baseline-1` 是 [baseline.mjs](../../tools/xj-dev/src/baseline.mjs) 中的最小场景生成逻辑，包含在 Git 中。实际 SQLite、随机密码和成员设备材料位于仓库外；团队基线 ZIP 位于私有 OSS，Git 中仅保留使用说明和版本线索。

## 成员使用

从 [项目 Skill](../../skills/xunjie-development/SKILL.md) 进入。首次调用时按需获取仓库、检查依赖和已有身份，缺少接入材料只索取一次本人邀请附件或路径；Agent 完成操作并主动介绍场景和数据归属。邀请是限时、一次性且绑定设备的加入凭证；日常复用设备身份，不重复领取。

首次空环境先登记但不启动，再导入团队起点，最后启动；不先播种内置库再覆盖。普通成员不需要负责人 SSH、云厂商凭据、CA 签发私钥或备份解密密钥。系统确实要求证书/安装确认时才由设备所有者完成。功能说明展示状态独立保存，后续会话仅补缺项并处理当前任务。

本轮 Mac 的本地、云端页面和本地前端连云端 API 均已实际就绪；系统 CA 信任验证成功，正常浏览器完成本地学生登录、课程和已分配任务显示。模型与真实执行能力按各自实际验证结果报告，三模式连通不能代替编译、仿真或模型调用验收。Windows新增入口的实测证据以本轮平台报告为准。

## 负责人备份与恢复

只在负责人要求备份、恢复、运行维护或排查凭据时读取本节；普通成员首次引导不加载这些材料。

负责人 Mac 的持续入口为 `~/.config/xunjie-cloud/README.md` → `CURRENT-STATE.md`，其中记录现行管理配置、签发材料、证书到期、设备登记和页面入口。秘密内容不进入 Git。恢复工具及契约见 [加密备份与隔离恢复](../../tools/i0-cloud/README.md#加密备份与隔离恢复)。

当前云端加密备份为 `/var/lib/xunjie/backup-archives/team-ready-20261024T123848Z-8d7746b2.xunjiebak`。Mac 独立副本在 `~/.config/xunjie-cloud/backup-recovery/team-ready-20261024/`，摘要为 `711e05d90e24ae312c71cb99f02a80fb1636333d4edf7949ff6a6bea31b51f84`，896,132 bytes。解密密钥为相邻上级目录的 `backup.key`，32 bytes、0600，密钥自身不进入备份。

该归档包含93文件、6个SQLite库，覆盖原业务回退、现行共享数据/模型、接入服务与凭据、运行配置、资源dropin、健康监控和25份helper回执。Mac已在新的隔离目录解密恢复：全部SHA、6库完整性/外键、3对TLS/CA、模型凭据3/0/3项、22项access凭据，以及1名active成员与受管SSH映射的关系检查通过。每个库独立一致，不是跨存储原子快照，也不等于已从空主机重新部署全部服务。

恢复始终写入新的空隔离目录。验证后再为目标主机重建路径、端口和socket；现行业务需重建上述 `development-current` 链接并取得对应已验证产物。不要用仍指向原库的配置启动第二个写进程。设备私钥与owner CA签发私钥不在服务器备份中；保留本机受限材料，丢失设备时通过新设备邀请恢复身份。

内置合成场景可以重新生成；课程作品、模型凭据和成员接入状态需要保留恢复材料。已有日备7份、周备4份按各自标签保留，切换前和本轮收尾归档另存。Mac独立副本不等于断开的离线介质；物理离线副本尚未制作。

## 证据入口

负责人私有目录 `~/.config/xunjie-cloud/team-development-20261024/` 保留数据承接、目录发布与备份收据，`owner-development/` 保留当前设备与模式结果；清理逐文件审计位于 `cleanup-audit-20261024/`。备份目录保留 `independent-verification.json` 与明文清理回执。

工程回归：30个测试文件，241通过、1项平台专项跳过、0失败。独立Skill四场景与有界代码审查无确定P1/P2；Mac实测另记上述模式与浏览器结果，Windows专项单列。真实执行、模型调用及教学效果未在本轮重测。
