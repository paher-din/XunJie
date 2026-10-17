# 本机合成课程发布入口

`seed-local-courses.mjs` 只负责已批准的 Robert 本机新合成库，以原教师 HTTP 流程建立 C / HDL 两个公开活动并分配。它不初始化数据库、不部署节点、不调用教师模型、不写学生源码、不构建或运行程序。

默认输出 dry plan，不读口令或配置，不连接网络。`--apply` 仅在本机 Linux root / Node 24.21.0 执行，固定连接 `https://127.0.0.1:3444`，严格验证已批准的本机证书；不连接 PAHER。

```sh
/opt/xunjie-runner/node/bin/node tools/i0-hdl/seed-local-courses.mjs \
  --teaching-root /absolute/source/apps/teaching

/opt/xunjie-runner/node/bin/node tools/i0-hdl/seed-local-courses.mjs \
  --teaching-root /absolute/source/apps/teaching \
  --config /opt/xunjie-ui-local/course-seed-config.json \
  --output /opt/xunjie-ui-local/course-seed-receipt.json \
  --apply
```

`--teaching-root` 是正常业务宿主所用源码的 `apps/teaching` 绝对路径，复用其原契约/schema 与校验函数。工具自身所在仓库需要保留公开合成 HDL 协议 fixture `tools/i0-hdl/fixtures/hdl-reference.json`。

配置不放密码，采用以下形状，全部路径是本机绝对路径；配置及 initializer 为普通文件、非符号链接、权限 0600：

```json
{
  "applicationConfigFile": "/opt/xunjie-ui-local/application-config.json",
  "initializerFile": "/opt/xunjie-ui-local/initializer.json",
  "readinessFile": "/opt/xunjie-ui-local/local-readiness.json"
}
```

`application-config.json` 使用原 `readApplicationConfig` 形状，origin 为 3444，SSH 为本机 `127.0.0.1:2222`；工具只读该配置，不读取 SSH 私钥、签名 secret 或 TLS 私钥。initializer 使用原 `syntheticManifestSchema`：`synthetic/recoveryGeneration/accounts/courses/memberships`，口令仅进程内用于原 `/api/sessions` 登录，绝不放入 argv、收据或日志。

原初始化器先建立三账号：`synthetic-robert-teacher`、`synthetic-robert-student-a`、`synthetic-robert-student-b`；两课程 `synthetic-robert-course-c` / `synthetic-robert-course-hdl`，教师及对应学生成员关系。C 分配给 student-a，HDL 分配给 student-b。

`local-readiness.json` 是本轮本机实际探测产生的原应答记录：

```text
{ recoveryGeneration,
  runner: { data: 原始 readiness 应答 },
  hdl: { data: 原始 hdl_readiness 应答 },
  approvedHdlRuntime: 原 HDL profile,
  ssh: 本机入口参考 }
```

保持原应答形状：C profile 在 `runner.data.fingerprint.profile`，并有原身份平铺字段；HDL profile 在 `hdl.data.profile`。工具用原 `availableRuntime` / `availableHdlRuntime` 检查该记录的指纹、验证和代际一致性，教师 checks / releases 还会通过原服务器重新探测当前节点；不能拿历史 PAHER passed 记录作为本机就绪。

执行链是正常教师登录 → 显式公开资料（`teacherDesignAllowed=true`，`material.visibility={student:true,tutor:true}`）→ 原 HDL 固定配置注册 → manual blueprint → checks → confirmed release → assignment → 对应学生登录 / bootstrap。原 HDL board、信号、ALU 结构域保持原公开配置；只替换新合成配置 ID 和本机已批准 runtime。原映射没有 resetN 绑定，页面应显示未绑定且不可操作。HDL checks 必须返回 `structural=validated` 和 `behavior=unverified`；阻塞或待教师处理的 concern 会停止发布。

如需要本次开发合成验证显式创建空 Attempt，可增加 `--create-attempts`；它只在对应合成学生身份下调用原 `attempt.create`，不编辑、保存、运行或提交。默认 bootstrap 本身不创建 Attempt。

输出收据只含公开合成 ID、原发布/分配/检查收据和请求状态。每个命令发出前保留原幂等键和 payload hash，中断后使用相同参数和同一 `--output` 重跑，复用原键核对原收据。不要删除收据后盲目重建活动；不匹配的数据库、代际、内容或 Attempt 选项会停止。登录材料不保存；结束时尝试原 logout。

正常 35 表宿主返回原 `CommandReceipt`，代际在 `data.identity.recoveryGeneration`，不读取旧验证宿主的平铺字段。工具复用原 `readCommandIdentity` 与 `requestHash`，核对 actor、command、target、course/student scope、原幂等键、代际及请求 hash；保存完整原 identity、receiptId、commandId、serverSeq、committedAt 和执行 sourceHash。已有收据的 replay 必须保持原收据内容；第一次资料 POST 已成功而客户端解析失败的情况保留在 `failureHistory`，修复后同一 prepared key 重试，不再创建一份资料。

当前原业务宿主没有教师 sample-run HTTP 路由，本工具如实记录 `not-executed/no-original-route`；不创建替代接口或宣称样例运行通过。本机 C1 实际预检、完整浏览器、模型正文与 displayed/ack、学生显式修订后的输出变化、ALU 行为与教学效果各自需要后续原流程证据。

## 显式全输入补充模式

`--full-inputs` 只给原本机 `synthetic-robert-course-hdl` / `synthetic-robert-student-b` 新建另一份 immutable 配置、活动和分配，不改原配置、主演示、原分配或 C 课程，不增加用户/课程/表，不调用模型。原服务端 `hdlConfigurationSchema` / `validateBoard` 允许额外 resetN 绑定；`storeHdlConfiguration` 使用新 versionId 存另一份配置且核同已批准 runtime，无需新增接口或共享契约。

新配置 `synthetic-robert-hdl-full-input-config-v1`，mappingVersion `synthetic-robert-full-input-mapping-v1`。原 topModule 仍为 `top`，额外 binding 是 `{signal:"resetN",offset:0,port:"rst_n",portOffset:0,width:1}`；16 SW / 5 BTN、AN/SEG/DP极性、原 ALU 结构域、clock/初始化值、runtime/镜像/sourceHash/限额不变。该活动自己的源码需在 `top` 声明 `input rst_n` 并自行实现低有效复位逻辑；配置结构通过不证明源码复位行为或浏览器操作成功。旧活动仍显示 reset 未绑定。

先 dry plan，无凭据读取或 HTTP；实际补充使用**单独 output checkpoint**，勿复用原 `course-seed-receipt.json`：

```sh
/opt/xunjie-runner/node/bin/node tools/i0-hdl/seed-local-courses.mjs \
  --teaching-root /opt/xunjie-ui-local/source/apps/teaching --full-inputs

/opt/xunjie-runner/node/bin/node tools/i0-hdl/seed-local-courses.mjs \
  --teaching-root /opt/xunjie-ui-local/source/apps/teaching \
  --config /opt/xunjie-ui-local/course-seed-config.json \
  --output /opt/xunjie-ui-local/course-seed-full-inputs-receipt.json \
  --full-inputs --apply --create-attempts
```

补充链仍是原 teacher login → public resource → configuration → manual blueprint → actual checks → confirmed release → assignment → student bootstrap（上例另显式建空 Attempt）。命令 label/key 和配置 namespace 分开，失ACK仍同原 key/完整请求/identity/scope/hash核对；输出不匹配会在发 HTTP 前停止。实际执行由主 Agent 在本机宿主就绪后完成；工具实现及离线契约检查不算已经发布或真实 reset 验收。
