# 团队开发当前交接入口

2026-10-24。本页记录本轮数据承接、成员入口与恢复线索；日常状态仍以 `xj-dev status`、实际 unit 和在线目录为准。当前交付分支为 `codex/development-collaboration-integration`，尚未合入 main。

## 服务与数据

| 单元 | 当前用途与状态 |
| --- | --- |
| `xunjie-candidate-128.service` | 唯一常驻共享业务，运行已验证的 `e03a3c9` 产物；技术名保留兼容现有接入与系统策略 |
| `xunjie-dev-access-candidate129.service` | 成员邀请、设备权限、团队目录和私有 OSS 授权；包含固定基线退役，源码以 current/deployment.json 为准 |
| `xunjie-shared.service` | 原业务服务定义及资源 dropin 已删除；原库、配置和加密恢复材料保留 |
| `xunjie-release-deploy.timer` | 旧 service/timer、自动发布器和部署配置已删除，不再有旧自动发布入口 |
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

Agent 按[数据基线](../development-tooling.md#获取与更新数据基线)在线核对条目，再采用固定版本。已有环境保持数据，需要另一版本时另建隔离副本。`acceptance-conflict / 0.2.0-20261024` 已从成员目录退役；其约6 MB不可变包及编号保留作历史验收追溯。维护者可查退役原因，原版本不可复用，日常采用 `team-demo`。

内置 `local-baseline-1` 是 [baseline.mjs](../../tools/xj-dev/src/baseline.mjs) 中的最小场景生成逻辑，包含在 Git 中。实际 SQLite、随机密码和成员设备材料位于仓库外；团队基线 ZIP 位于私有 OSS，Git 中仅保留使用说明和版本线索。

## 账号来源

本地恢复团队基线时为11个测试身份重新生成随机密码；从 `up/status` 的 `accounts.credentials.file` 取得受限文件，Agent按需要登录，密码不进Git或普通输出。云端成员加入后取得自己的应用账号，文件路径由 `enrollment.accountFile` 返回；它与本地基线账号独立。原演示账号未因承接而重置，负责人资料仍在仓库外的 `~/.config/xunjie-cloud/accounts.private.txt`，不作为全员共用账号。

## GitHub 接入与首批成员

已在负责人 `wubq511` 名下注册 `XunJie Development Access` OAuth应用并开启Device Flow，公开client ID为 `Ov23liVvSJjyCIG3k5VF`，仅请求公开身份，不申请仓库读写范围。应用管理入口为 GitHub Settings → Developer settings → OAuth Apps；未创建client secret，注册页保留的loopback回调不参与设备授权。成员只需在GitHub页面确认身份和短码，由服务端完成身份解析；批准记录使用固定GitHub numeric ID，公开仓库可读或未来贡献记录不会自动增加权限。

| GitHub用户名 | 固定ID | 团队角色 | 云端应用角色/范围 |
| --- | --- | --- | --- |
| `wubq511` | `231859783` | maintainer，绑定原Robert身份 | teacher / `synthetic-i0-course-a`，page与文件读写 |
| `paher-din` | `209876481` | developer | teacher / 同上，page与文件读写 |
| `czr112` | `232176190` | developer | teacher / 同上，page与文件读写 |
| `scy404` | `240625698` | developer | teacher / 同上，page与文件读写 |

四项批准已由owner通道写入并读回；后三位首次完成本人GitHub确认时才创建应用账号和设备，当前仍为not-enrolled。名单不授予owner SSH、云厂商权限或执行节点。维护命令与用户流程见[GitHub接入契约](../../tools/xj-dev/README.md#github-登录与首次接入)，实时名单用 `access github-list` 查询。

接入服务部署源码为 `d55d137fb27e305f788edbac966a2f1123d05c4e`，共享业务仍为原e03进程。Mac和Windows各用独立工具home完成真实GitHub授权、设备登记、受管SSH连接、云端网关严格TLS、应用登录/session/logout 200。GitHub网页确认在Mac浏览器完成；Windows使用经SSH运行的固定提交工具源码快照及Node24.21，不把该结果写成Windows产品浏览器或整仓checkout验收。此前全量tar传输遇到三个课程/文档非运行文件名的Windows解包错误，已改用明确选定的工具/运行源码完成验证，原Windowsdirty工作副本保持。Mac相关16个测试文件122项通过，独立审查发现的三项撤销/信任/重试问题均修复并复核；工程与实机证据分别保存。

两台临时设备已通过原revoke-device链路关闭，CLI后续访问均被拒绝；临时会话敏感载荷、两端home/source、传输包和进程均已清理。四人名单与Robert原日常设备保留。模型、真实编译/仿真及教学效果未在本轮重测。

## 成员使用

从 [项目 Skill](../../skills/xunjie-development/SKILL.md) 进入。首次调用时按需获取仓库、检查依赖和已有身份，首次走GitHub网页确认，Agent自动登记并主动介绍场景和数据归属；普通成员无需传邀请附件。已有设备复用proof/refresh，功能介绍只展示一次。

首次空环境先登记但不启动，再导入团队起点，最后启动；不先播种内置库再覆盖。普通成员不需要负责人 SSH、云厂商凭据、CA 签发私钥或备份解密密钥。系统确实要求证书/安装确认时才由设备所有者完成。功能说明展示状态独立保存，后续会话仅补缺项并处理当前任务。

本轮 Mac 的本地、云端页面和本地前端连云端 API 均已实际就绪；系统 CA 信任验证成功，正常浏览器完成本地学生登录、课程和已分配任务显示，以及本人受管账号的云端教师工作台登录。模型与真实执行能力按各自实际验证结果报告，三模式连通不能代替编译、仿真或模型调用验收。

Windows 使用独立临时源码与 pinned Node24.21.0，登记、团队目录/导入、未开始任务和盘符根目录专项共31通过、1项POSIX权限检查跳过；团队基线测试的Unix管理socket夹具已单独适配，真实HTTPS/proof/读取权限断言保留。过深私有文件路径在本轮主机的.NET ACL接口仍失败，日常保持默认工具目录；不把这一结果写成任意长路径兼容。此次未在Windows重做正常浏览器或真实云端加入验收，旧dirty工作副本保持原样。

## 负责人备份与恢复

只在负责人要求备份、恢复、运行维护或排查凭据时读取本节；普通成员首次引导不加载这些材料。

GitHub接入上线后的最新归档为 `/var/lib/xunjie/backup-archives/github-ready-20261024T155720Z-6ecdf635.xunjiebak`，901140 bytes，SHA256 `c78f0161b61ebba6944040eac0fe37633dd517d31e66e258cee7cb63852589c1`。Mac副本在 `~/.config/xunjie-cloud/backup-recovery/github-ready-20261024/`。已独立恢复92文件/6库，核对摘要、外键、TLS/CA、模型和22份access凭据；四人批准名单、1个日常SSH映射及2个临时设备撤销状态均正确，临时GitHub会话载荷已清除，恢复明文也已删除。下文旧归档保留各自时点的恢复范围，不替代最新快照。

负责人 Mac 的持续入口为 `~/.config/xunjie-cloud/README.md` → `CURRENT-STATE.md`，其中记录现行管理配置、签发材料、证书到期、设备登记和页面入口。秘密内容不进入 Git。恢复工具及契约见 [加密备份与隔离恢复](../../tools/i0-cloud/README.md#加密备份与隔离恢复)。

数据承接时的加密备份为 `/var/lib/xunjie/backup-archives/team-ready-20261024T123848Z-8d7746b2.xunjiebak`。Mac 独立副本在 `~/.config/xunjie-cloud/backup-recovery/team-ready-20261024/`，摘要为 `711e05d90e24ae312c71cb99f02a80fb1636333d4edf7949ff6a6bea31b51f84`，896,132 bytes。解密密钥为相邻上级目录的 `backup.key`，32 bytes、0600，密钥自身不进入备份。

该归档包含93文件、6个SQLite库，覆盖原业务回退、现行共享数据/模型、接入服务与凭据、运行配置、资源dropin、健康监控和25份helper回执。Mac已在新的隔离目录解密恢复：全部SHA、6库完整性/外键、3对TLS/CA、模型凭据3/0/3项、22项access凭据，以及1名active成员与受管SSH映射的关系检查通过。每个库独立一致，不是跨存储原子快照，也不等于已从空主机重新部署全部服务。

恢复始终写入新的空隔离目录。验证后再为目标主机重建路径、端口和socket；现行业务需重建上述 `development-current` 链接并取得对应已验证产物。不要用仍指向原库的配置启动第二个写进程。设备私钥与owner CA签发私钥不在服务器备份中；保留本机受限材料，丢失设备时通过新设备邀请恢复身份。

内置合成场景可以重新生成；课程作品、模型凭据和成员接入状态需要保留恢复材料。已有日备7份、周备4份按各自标签保留，切换前和本轮收尾归档另存。Mac独立副本不等于断开的离线介质；物理离线副本尚未制作。

旧服务退役前另有 `pre-retirement` 加密归档，Mac已独立恢复97文件、6库并核对账号/模型/TLS关系，明文已删除。退役后备份策略移除9个已删除源文件，保留原库并改用现行产物加载SQLite驱动。退役回执与最新归档/独立恢复结果从负责人 `CURRENT-STATE.md` 的退役段落进入；恢复旧快照时不自动重新启用其中的旧服务。

## 证据入口

负责人私有目录 `~/.config/xunjie-cloud/team-development-20261024/` 保留数据承接、目录发布与备份收据，`owner-development/` 保留当前设备与模式结果；清理逐文件审计位于 `cleanup-audit-20261024/`。备份目录保留 `independent-verification.json` 与明文清理回执。

工程回归：30个测试文件，241通过、1项平台专项跳过、0失败；之后仅修改的跨平台测试夹具在Mac专项13/13通过。独立Skill四场景与有界代码审查无确定P1/P2；Mac实测另记上述模式与浏览器结果，Windows专项单列，重复覆盖不相加。真实执行、模型调用及教学效果未在本轮重测。
