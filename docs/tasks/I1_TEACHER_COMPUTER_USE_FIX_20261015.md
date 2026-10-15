# I1 教师端实测复查与修复（2026-10-15）

## 依据、授权与写集

负责人要求“根据这轮实测结果复查并修复问题”。基线 `cb14a68014c27f35daf9c7235c060a170f7c97fd`；开工无已跟踪文件差异，保留既有未跟踪记录与截图。采用本地分支 `codex/teacher-login-entry-fix`。

已读 README、AGENTS、[实测记录](I1_TEACHER_COMPUTER_USE_20261015.md)、[统一登录批准与实施](I0-UI_SHARED_DEMO_ACCOUNTS.md)、PRD §8、MVP M-10、TECH §9，以及DESIGN颜色/字阶/布局与现有登录表单。适用M-10、AC-02/12和真实Session/角色落点边界。

当前明确修复范围：登录标题与所选角色一致；保持统一页面、同一登录请求和服务端授权，不能凭教师选项提升权限。可写SessionEntry.tsx、既有sessionEntry.spec.ts、本人本任务及原实测补充记录/证据。其余应用模块、凭据、配置、数据库、产品/规划/参考/规范只读。修复后按code-review技能对相对本基线的最终提交进行Standards/Spec两轴复查。

## 复查结论与方案

- 原19项预览操作符合预期，原始记录与截图保留。
- 统一登录页是批准设计，但目前h1固定为“登录学习空间”，教师说明与身份选择已动态改变。将h1也绑定同一entryRole，教师显示“登录教师工作台”，学生保持原文；不拆页面或引入新认证协议。
- 在既有角色矩阵中核初始深链标题、选择后的标题与实际角色落点，增加教师模型深链案例；登录请求依旧只发账号/密码，不发角色授权参数。
- 真实模型入口在5601无业务后端时显示连接失败，属于环境阻塞；不改为fixture回退、不搭建/迁移服务、不填Key或发付费请求。
- 原生窗口读取审批限制已通过独立项目标签规避无关信息读取；该限制不是项目代码缺陷。

## 验证与交付

### 已执行

- 红验证：增加教师模型深链标题断言后、修改组件前，单跑该用例失败，实际仍是“登录学习空间”；[日志](evidence/teacher-computer-use-fix-20261015/login-title-red.txt)。
- `apps/student` 下 `npm run typecheck`、`npm test -- --run`、`npm run build` 均退出0；单元测试54文件、657/657通过。构建保留既有大于500 kB分块提示，没有为此改配置。[类型检查](evidence/teacher-computer-use-fix-20261015/typecheck.txt)、[单元测试](evidence/teacher-computer-use-fix-20261015/unit.txt)、[构建](evidence/teacher-computer-use-fix-20261015/build.txt)。Node为24.21.0。
- Computer Use：在独立内置浏览器tab5打开5601的`/#/teacher/settings/model`；初始教师标题正确，切学生显示“登录学习空间”，切回教师恢复“登录教师工作台”，说明文字同步。未输入账号、密码或Key；[实际页面截图](evidence/teacher-computer-use-fix-20261015/teacher-login-fixed.png)。
- 扩展浏览器回归：`sessionEntry.spec.ts teacher-ui.spec.ts teacher-model-settings.spec.ts homeEntry.spec.ts real-mode.spec.ts`，Chrome、独立5651/5652/5653端口、CI=1；32项中31通过、1失败。[完整日志](evidence/teacher-computer-use-fix-20261015/browser-green.txt)。失败不能计为通过。
- 失败为`real-mode.spec.ts:159`：学生HDL工作区关闭任务信息后点击“退出”，被`.ws-head-tabs`中的“波形”截获指针而超时。该测试及`PrepWorkspacePage.tsx`、`app.css`、`HdlToolArea.tsx`相对开工基线均无差异；未声称已在独立基线重跑复现。它不经过本轮修改的登录标题，列为学生工作区后续修复交接；未用force点击、扩大视口或删除断言掩盖。临时trace/error-context留于`.tmp/teacher-ui-review-fix-20261015/green`，提交日志保留定位信息。

### 待完成与边界

教师相关四组浏览器回归已逐项输出25个ok，runner收尾退出状态待确认；结束后保存独立日志。`node tools/a0-review/check.mjs`检查159份文档、2162条内部链接，errors为空；`git diff --check`通过。Standards/Spec最终审查结果待补。

提交证据日志只规范行尾空白和文件末尾空行，保留内容；原始副本在`.tmp/teacher-ui-review-fix-20261015/raw-*.txt`。本机Git未配置作者，使用本次命令临时作者`Codex <codex@openai.com>`，不修改本机/仓库Git身份配置、不冒用负责人身份。

仅本地Git交付，不推送或部署。原实测因未绑定不可变运行产物，只表示当时Vite页面观察，不扩展为当前完整产品验收。真实教师登录、模型供应商读写/生成、真实师生数据交互仍因未接可用业务宿主未执行；不得以预览或协议替身通过替代。产品基线及MVP_SPEC §10待授权维护者汇总。
