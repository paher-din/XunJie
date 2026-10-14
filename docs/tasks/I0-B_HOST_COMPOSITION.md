# I0-B：正常辅导宿主组合实施补充

日期：2026-10-14（Asia/Shanghai）。主责：当前Agent / UI整合。父记录：[六票计划§10–11](I0-B_UI_TUTOR_PLAN.md#10-2026-10-13-继续核查真实验收缺口)。状态：`implemented / service-synthetic-verified`；最后前端组合与本地提交记录见父§11。这是原六票的实施补充，不增加第七张ticket，不代替A/B/C与产品基线。

## 依据、授权与写集

已读README、AGENTS、PRD §4.2/5/8、MVP_SPEC M-04/M-05/控制与验收边界、TECH §7.2/7.3/7.4/7.5，原I0-A/C固定回交§12/13，以及B2、C3原执行/记录/事务接缝。适用M-04/05/09/10、AC-06/07/12/15、NFR-04/05。Robert已对父记录§10.3具体方案授权由当前Agent判断必要性并实施；主核实正常辅导链确实需要本组合。

从`origin/codex/i0-a-c-handoff@c071b4d`选择性复用原`contracts/design/i0.ts`、`server/app/config.ts/i0.ts/i0-static.ts/i0-initialize.ts/i0.test.ts`和`server/main.ts`，不做Git merge、不接纳作者文档/README、不把他人Draft标合入。保留原24表C模式与bootstrap；本批仅在明确教学配置下使用已有28表教学工厂及原B2/C3服务。新增必要宿主/worker专项；B2 `server/tutoring/application.ts`作内部Job执行接缝的小适配，复用原候选执行和C3最终接纳，不新增HTTP执行接口。包/lock、规范、保护文档、真实配置/凭据、CI、旧库/schema与节点只读。

## 方案与边界

当前B2执行接缝要求FastifyRequest中的学生Session；正常持久Job消费者不能保存或伪造学生cookie/CSRF。内部worker从原持久Job确定course/student/Attempt，在每次事务重新核当前账号、active课程成员、原Attempt/分配与原Job/回执/学生问题摘要，复用原政策、对象和当前性守卫。该入口仅供受信宿主模块调用，不注册HTTP、不创建Session、不修改用户身份权限；接受过的Job不是新的学生请求。禁止拿内部worker去执行浏览器任意传入的scope/正文。

原模型调用预留、三次累计上限、45秒期限、租约/代际、停止意图与C3最终动作接纳继续使用现有实现；真实正文经过原B校验/C事务后才进入公开事件。失败/过期/重启原Job保持原身份，不回queued自动产生替代调用，已生成正文及已展示事实不被关停删除。C运行与教学消费者独立推进，模型等待不阻塞运行对账；关停阻止新接纳/dispatch，持久停止并中止本进程在途教学调用，不把未知执行标为已确认停止。

正常配置沿现有受控文件读取。新增教学开关/版本/预算与已有provider配置引用只作必要代码接口，不生成或改写任何真实配置、证书、签名/API key，也不打开真实模型调用。隔离验证仅使用现有合成provider、合成学生和原数据库工厂，全部新库保留；不迁移或重置旧库。缺正常TLS/合成账号安全交接/受控C代际时，明确留下该环境验收，源码/隔离HTTP不冒充实际环境通过。

## 验证与实际交付

WSL2 Ubuntu，官方Node24.21.0 Linux包SHA-256核对通过；沿原教学lock npm ci安装70包，0审计漏洞，未改package/lock。npm提醒原better-sqlite3 install-script未获npm allowScripts覆盖；随后用该Node捆绑node-gyp直接重建原native模块退出0，不修改allowScripts或依赖。运行时/缓存在D盘，不改系统Node。

实际后端typecheck/build退出0。原固定宿主10项与新增辅导宿主6项合计16/16通过；D-01投影9项和D-03检查6项同次组合，共31/31通过。随后原默认`npm test`为399项、387通过、12跳过、零失败；31中15项投影/检查已包含在默认集，不重复累加。新增16项宿主专项不在原默认glob中，单独记录。实际节点、容器/VM、SDK/模型批次等环境门禁未打开，12项skip不算通过。

独立只读复核确认并修了两个根因：C消费者等长请求时阻塞教学dispatch，现分离计时器/在途Promise；内部worker最后接纳遗漏组合learner revision守卫，现与公共C3完成使用同一最终事务守卫。新增两条专项覆盖真实异步等待与最终事务版本变化，均通过。模型任务仍受原Job/租约/截止/停止意图约束，未知租约不重新dispatch。

默认集第一轮386通过/1失败/12跳过，唯一失败为并行负载下无效PORT启动超过原5秒限时。单独原4项startup复验先通过；随后main在校验端口后才动态载入HTTP宿主，保留原断言/限时。重建后原4项通过，无效配置拒绝约0.7秒；再跑默认集得到上述387通过/12跳过/零失败。没有加超时、关闭检查或修改原startup测试。

[实际服务浏览器专项](../../apps/student/e2e/tutoringService.spec.ts)使用正常学生dist、实际HTTPS/Fastify/SQLite、真实Session/CSRF及原内部worker。测试账号密码只经私有stdin传入，临时TLS key/cert不输出、不入库、不安装信任；独立库沿原工厂保留，关闭时仅清理本用例证书目录。离线provider明确标“隔离合成服务验证”，无供应商外发。实际登录后只读授权深链，学生显式创建、保存、冻结、项目求助和代码快照求助；相同正文仍按两个原Job/Action/对象核对，另一个标签只回取shown历史且零写请求。扩展专项1/1通过（16.7秒），最终组合结果见父§11。

扩展专项曾在第二次求助等待超时：第一个help已由服务接纳并产生正文，但UI仍标原请求待核对。核对B2原records-adapter发现该help回执摘要包含完整验证输入及recoveryGeneration，客户端错误套了workspace删代际规则。已仅修客户端help digest和同authority准备摘要，C cancel的`{jobId,reason}`语义保持；原B2后台契约未改。新增3条固定原后端摘要向量/归属/取消反例通过，正式dist重建后上述双求助链通过，不能把早期仅见正文的结果当完整help确认通过。

## 正常启动与仍未执行项

业务启动使用`XUNJIE_I0_CONFIG`引用已有受控JSON，`PORT`须与该HTTPS Origin端口一致；不设配置仍为原健康服务。字段验证见[配置源码](../../apps/teaching/server/app/config.ts)：数据库、TLS key/cert、签名、SSH、staticDirectory引用已有维护者交付文件，generationFile提供可信恢复代际。`tutoring`为可选组合，含已批准版本和已有provider key引用，`callsAuthorized`默认false；没有key或新调用授权时不调用实际供应商，不回退合成成功。

`i0-initialize.ts`只使用原24/28表工厂创建独立合成新库；schema、迁移、旧库和成员配置不修改。正常宿主精确表集检查、静态白名单、scope授权与重启/停止边界均沿原能力。源码入口为[i0.ts](../../apps/teaching/server/app/i0.ts)、[B2 application](../../apps/teaching/server/tutoring/application.ts)、[main](../../apps/teaching/server/main.ts)，前端使用见[学生README](../../apps/student/README.md)。

未执行受控部署证书链/实际节点SSH与隔离运行、真实供应商/模型语义批次、真实教师例子审批或真人自主接棒。当前自签名loopback条件与offline provider不代表这些验收；它们不是剩余代码待实现，也不据此关闭父Issue或宣称完整AC/NFR、G阶段或教学效果通过。产品基线/MVP_SPEC §10待授权维护者汇总。
