# 教师闭环的本机受控验证

本工具只用于 Robert 已准备的 `https://127.0.0.1:3444` 合成环境。范围、批准、备份和实际验证见 [I1-TEACHER](../../docs/tasks/I1-TEACHER_UI_WORKBENCH.md)。PAHER 共享服务由[共享数据任务](../../docs/tasks/I0-UI_SHARED_DATA_ENTRY.md)维护，本工具不操作该服务。

## 日常启动

已获准升级的本机库有精确 41 表，保留原 35 表数据。使用原 PowerShell 7 入口：

```powershell
.\tools\i0-hdl\xunjie-local.ps1 start -EnableReview
.\tools\i0-hdl\xunjie-local.ps1 check
```

教师设计模型预算仍关闭；已有个人模型设置沿其原授权保留，本验证不发送模型请求。打开 `https://127.0.0.1:3444/#/teacher`，使用本机原教师合成账号。凭据沿用本机受限初始化文件，不在仓库或测试产物中保存。

## 一次性升级工具

`enable-review.mjs` 仅接受硬编码的现用本机合成库和 Linux Node24.21.0；默认 `--check` 只核对升级前的精确 35 表、合成身份和完整性，不写数据。`--apply` 仅在已有明确批准且原宿主停止后运行：SQLite backup → 备份完整性及 SHA256 → 单事务加入既有 review 六表四索引 → 原对象/原行数/精确 41 表/外键核验。它不会增加显示列，也不会自动删除、回退或恢复旧库。已升级库不应重复运行该一次性工具；用日常健康入口检查宿主。

旧源码/静态和迁移前库的核验位置记录在任务文件。41 表库不能直接由默认 35 表宿主打开；需要回退时按任务记录协调保留现场和备份，不将旧库覆盖回现用库。

## 真实 Chrome 验证

`verify-browser.mjs` 默认只输出计划，不读取口令、不联网、不启动浏览器：

```powershell
node tools/teacher-workflow/verify-browser.mjs --course c
```

显式 `--run` 使用已安装 Chrome、严格 TLS 和两个独立 browser context；只从受限本机初始化文件将确切合成账号凭据读入内存。全部业务写入通过真实可见 UI 控件，GET 仅核对原对象；不使用协议替身、不记录 trace、Cookie 或口令，也不调用模型或运行节点。

```powershell
node tools/teacher-workflow/verify-browser.mjs --run --course c --output D:\XunJie_Project\artifacts\teacher-c
node tools/teacher-workflow/verify-browser.mjs --run --course hdl --output D:\XunJie_Project\artifacts\teacher-hdl
```

验证会在合成库留下独立项目、分配、尝试、两次固定提交、反馈修订和许可记录。结果保留原对象 ID、快照 SHA、请求路径/方法/状态与窄屏截图，不计真人学习证据。`--resume <checkpoint.json>` 仅续作该检查点；结果未知且读取无法确认时停止，不换对象或换键重造成功。最终通过须同时满足业务断言、旧快照保持、页面错误和窄屏布局判据；失败不会被默认计划或服务端预交付替代。
