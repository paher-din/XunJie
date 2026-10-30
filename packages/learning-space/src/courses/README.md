# 课程、任务与固定发布版本 owner

本模块与 spaces 同属空间/课程 owner，拥有课程、项目任务、不可变发布版本、课程资格和活动关联准备记录。学习数据 owner 只通过 `prepare/confirm/authorize` 窄接口消费，不能直接读写本模块表；产品宿主也不拼接两侧事务。

| 能力 | 行为 |
| --- | --- |
| `registerRelease` | 消费版本化导入清单与资源字节；先校验路径、重复、摘要/长度、起始作品引用和资源归属，再用稳定 `uploadId` 写入资源并重读，最后在所属短事务登记课程/任务/发布/材料引用与回执 |
| `registrationResult` | 按原登记请求查询已持久化结果；未知返回 null |
| `listCourses/readRelease` | 每次核验当前成员与课程资格，只构造学生开放投影；私有材料名称、正文和资源 locator 不下发 |
| `readMaterial` | 按发布与材料身份核验资格、材料归属和资源完整性后返回字节；私有或未知材料统一不可见 |
| `setAccess` | 管理者授予或撤销课程资格，不改变成员身份、既有活动归属或发布版本 |
| `prepare/confirm/bindingResult` | 学习数据 owner 的跨 owner 活动关联准备、重新核验当前资格与资源完整性后的确认，以及原身份查询 |

发布内容以规范化 JSON 存储并计算摘要；相同 `releaseId` 改内容、相同请求改输入或同一任务错绑均拒绝。修改课程内容必须产生新 `releaseId`。材料通过 `stageResource` 持久写入，并以 `<releaseId>:<materialId>` 引用保留；新增版本、撤权或关闭活动不解除旧版本及其材料。

`spaceCourseMigrations` 是空间/课程 owner 的完整迁移集（既有空间版本 + 课程 schema）；生产运行时、维护参与者和恢复目标都消费它。`createCourses(storage, spaces).validate()` 校验课程/任务/发布/材料/引用/资格/关联/登记的一致性，资源字节完整性由 storage 参与者的校验覆盖。

导入清单格式见 `@xunjie/contracts/courses` 的 `courseImportSchema`；正式命令为 `xunjie course-import`（资源按材料 `path` 从清单所在目录读取并校验），资格与结果查询为 `xunjie course-access`、`xunjie course-result`。

```sh
npm run build -w @xunjie/learning-space
node apps/server/tests/course-releases.runtime.test.mjs   # 需要 XUNJIE_PRODUCT_POSTGRES_BIN
```
