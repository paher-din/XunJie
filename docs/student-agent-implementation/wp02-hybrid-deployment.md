# 混合部署与业务恢复接管

对应 [#154](https://github.com/paher-din/XunJie/issues/154)，方案与测试边界见[实施方案](specs/wp02-hybrid-deployment.md)。同机多进程与旧 WP01 证据不代替本票实际跨机验收。

## 部署绑定

个人本机和学校共享沿用正式产品页及现有 owner。混合组合使用学校的身份、成员和课程，本机安装客户端持有学习数据。本机主动经 WP01 认证连接访问学校，学校连接凭据逐次核验本人及课程资格；学校不需要访问学生私网端口。SSH 仅用于部署维护，不转发学生产品流量。

1. 用完整产品包安装、启动客户端。`xunjie status --root <客户端root>` 的 environment 中找到 `unit=learning-data`，记录其 environmentId/serviceId，组成 `{environmentId,serviceId,version:1}`。
2. 在学校执行 `xunjie school-member --root <学校root> --file <私密成员JSON>`。输入为 requestId/loginName/password，加上述 `target`；省略 target 保持学校共享默认行为。绑定只允许首次登记或同值幂等核对，不支持改 URL 为既有作品另选所有者；已有共享成员须通过正式迁移改变部署。
3. 学校执行 `xunjie authorize --file <源身份JSON> --out <新私密授权文件>`，源 environmentId/serviceId 必须是客户端实际 learning-data owner，capabilities 为 `["learning.authority"]`。学校须在线且已装配真实模块，传输授权不替代学校成员或课程授权。
4. 客户端执行 `xunjie connect --file <私密连接JSON>`。target 使用学校实际运行入口 `services[0]` 描述，requiredCapabilities 必须包括 learning.authority，不能降为 optional。文件包含 token，只留私有目录，不能进入公开描述或日志。
5. 客户端正常连接学校入口，学校页面登录批准后完成连接。维护者执行 `xunjie learning-binding --root <客户端root> --file <绑定JSON>`，输入 `{connectionId,runtimeConnectionId,target}` 分别对应学校成员连接、WP01 连接及第一步的目标。这是管理员入口，不是学生选择数据库/节点的设置。

课程读取仍沿原学校服务，课程活动 prepare/confirm/authorize 保留原主体、请求、发布版本及资源依据；活动和作品进入本机唯一 owner。每次操作核对实际成员绑定、运行连接环境/服务/版本；工作区还核对预期主体与客户端恢复命名空间。失联、维护、撤销和身份/版本不符在原范围报错，保留浏览器内容，不另建共享或个人副本。

## 维护与备份

每个完整安装的 runtime、space-course、learning-data 均是必要参与者。关闭新业务接收与派发，排空 HTTP 和已接收领域 capability，验证全部 owner 后导出数据库与已发布资源清单。参与者缺失、资源缺项或关闸失败使完整备份失败，不能忽略业务后继续。

单安装备份只覆盖它持有的权威数据。混合环境应先让学校保持 held 关闭边界，再让本机保持 held 边界，分别取得完整备份；登记两者 backupId、boundaryAt、owner/schema/资源摘要及共同关闭区间，不把两份在线快照称为分布式原子备份。备份目录独立于运行数据和资源根，密钥另行私有保管，公开 manifest 不含密码或连接 token。

产品备份**不包含浏览器未同步内容**。旧浏览器库和队列保留在旧 namespace，不自动迁移/重放。需要取回时保留旧页面，导出原文及原请求身份，先核实主体、目标与原请求回执，再显式处理竞争或续接原操作；不能换新请求掩盖未知结果。本票没有自动导入旧浏览器队列的入口。

## 独立恢复与远端接管

用原 restore/upgrade 私密输入从实际备份恢复到独立空 root。目标默认 isolated，保留原业务身份及活动/对象/内容/请求，生成新 installation、凭据与 client namespace。先验证原课程、材料、作品与回执，再按 WP01 机制退休源并 fence 全部 receiver；缺证明或接收方失败时保持隔离。失败保留源、原备份和现场，不能只换旧 binary 当回滚。

同机 receiver 保持 `{id,root}`；远端学校使用正式 takeover 的 SSH 适配：

```json
{
  "sourceRoot": "<本机仍在线的源root>",
  "receivers": [{
    "id": "<学校environmentId>/<学校运行serviceId>",
    "ssh": {
      "configFile": "<本机已有部署SSH配置的绝对路径>",
      "host": "approved-school-alias",
      "nodePath": "/opt/xunjie/resources/node/bin/node",
      "cliPath": "/opt/xunjie/app/cli.js",
      "root": "/srv/xunjie/school"
    }
  }]
}
```

适配器使用既有 SSH 配置与严格主机核验、禁止 agent 转发，不接受新主机身份或索取/打印密钥。远端完整包的 fence-source CLI 通过 stdin 接收无秘密源 service 清单，先核对 receiver 身份，再调用同一 WP01 私有控制 API；非零退出、超时、错身份或不完整结果不能确认接管。首个远端学校支持目标仍是 WP01 的 Ubuntu 24.04 x64 组合；Windows/Mac 是客户端。旧包没有此 CLI 时须先明确更新部署包，不能忽略失败。

接管后，接收方重新 authorize，目标用 set-credential 写回保留连接的原 credentialRef；不能重复 connect 同一 connectionId。学校页面重新批准新成员连接，再执行 learning-binding。学校数据库恢复后旧 cookie/连接凭据也失效，须重新登录授权。恢复活动可读不表示旧浏览器队列已导入。

本票没有新增 schema 迁移；正式 CLI 应到达 no-schema-upgrade-registered 校验，不报告本票执行过数据库版本升级。后续 #152/#153 的新增状态由对应 owner 迁移和恢复验证承担，本次不创建占位成功。

## 验证记录

工程、Windows Chrome、故障/恢复和未执行项将在最终交付登记。此前 WP01 学校主机为 101.201.141.133，现有受管配置可核对主机 pin，但本机凭据对部署用户 xunjie-admin 返回 Permission denied (publickey)。普通成员页面/文件权限不能替代部署权限，未修改现行共享服务。Mac 的实际执行集中 [#155](https://github.com/paher-din/XunJie/issues/155)；教学效果未评估。
