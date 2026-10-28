# 无扰式教学引导：开源实现调查

> 调查日期：2026-10-23。范围限 **pyBKT、OATutor、Vowpal Wabbit** 三项；OATutor-Content 只用于核对 OATutor 实际绑定的参数与内容许可。第三项选择 VW，是因为本议题需要动作概率记录和 IPS/DR 离线评估；未调查 MABWiser，不作两者性能比较。
>
> **证据层级：**「源码核验」表示在线读取官方仓库固定 commit 的代码、配置或示例；「静态数据核验」表示解析仓库中的 JSON；「推论」表示针对 XunJie 的接入判断。**本次未安装依赖、执行模型训练/推理、运行仓库测试或产品服务，也未取得生产学习日志。工程运行、浏览器验收与教学效果均未验证。** 本文不替代主线的本地事件审计与综合方案。

这些项目提供了可复用部件，但没有一项能直接把跨课程的普通编辑、停留和点击变成可信的“持续困难”或“帮助有效”结论。**知识追踪需要已定义的技能与作答观测；bandit 需要已观测的结果及动作概率。两者都不能凭空产生“有帮助”的真实标签或奖励。** 减少主动询问是可行方向，前提是正常学习过程本身能提供有明确含义的结果证据。[P-Input] [O-Answer] [V-Label] [V-DR]

## 固定版本与核心比较

以下为本次实际读取的源码快照，不宣称它们是最新发行版、稳定版或已完成部署验证。

| 项目 | 固定 commit SHA | 已核对许可 |
| --- | --- | --- |
| [CAHLR/pyBKT](https://github.com/CAHLR/pyBKT/commit/9bfeb31c09ea63c5962afc06b3935b5eefb4029e) | `9bfeb31c09ea63c5962afc06b3935b5eefb4029e` | 根目录 `LICENSE`：MIT。[P-License] |
| [CAHLR/OATutor](https://github.com/CAHLR/OATutor/commit/e24c8456e5f75c07b6048159ea9e128b036f673d) | `e24c8456e5f75c07b6048159ea9e128b036f673d` | 主程序根目录 `LICENSE`：MIT。[O-License] |
| OATutor 绑定的 [CAHLR/OATutor-Content](https://github.com/CAHLR/OATutor-Content/tree/1925decc91567faf6203bdb41b9d52b14891426f) | `1925decc91567faf6203bdb41b9d52b14891426f` | 内容仓库 `README.md` 的许可声明：CC BY 4.0，具体内容另带署名。不能把主程序 MIT 直接套到题目、提示与支架内容。[O-Submodule] [O-Content-License] |
| [VowpalWabbit/vowpal_wabbit](https://github.com/VowpalWabbit/vowpal_wabbit/commit/00196b35f63bcb8a6d66966e2b4cf67d6a2bd335) | `00196b35f63bcb8a6d66966e2b4cf67d6a2bd335` | 根目录 `LICENSE` 与 `setup.py`：BSD-3-Clause。[V-License] [V-Build] |

| 实现 | 可复用能力与源码证据 | 必须提供的输入 → 输出 | 训练数据、部署条件 | 对开放报告／代码项目的直接适用性 |
| --- | --- | --- | --- | --- |
| **pyBKT** | 按技能拟合 BKT；预测下一次作答和掌握状态；`Roster` 按学生、技能更新状态。`models/Model.py`、`models/Roster.py`。[P-Model] [P-Roster] | 有顺序的 `user_id`、`skill_name`、`correct`，可指定 `order_id`；正确性为 `-1/0/1` → `correct_predictions`、`state_predictions`，以及技能参数。 | 需要本课程可解释的技能标签与响应序列，或人工初始化参数；仓库测试含合成序列。Python、NumPy、pandas、requests；可选 C++/OpenMP 构建，另有纯 Python 路径。[P-Input] [P-Fixture] [P-Build] | **不能直接使用原始操作流。** 代码检查、报告量规必须先转成可信的技能观测；输出不是“学生困惑概率”“现在打断有益概率”。此项为接入推论。 |
| **OATutor** | 答题／提示事件到真实日志写入的链路；首次作答 BKT 更新；按掌握度选题。`ProblemCard.js` → `Problem.js` → `BKT-brain.js`；`Firebase.js`。[O-Answer] [O-Update] [O-BKT] [O-Log] | 教师定义的步骤、答案、KC、提示、参数 + 学生作答 → `isCorrect`、`probMastery`、事件记录和后续题目。 | 浏览器加载静态参数并更新状态；已核验的默认／实验参数均为统一初值，不能称为训练产物。完整应用需 React/Node 构建与内容子模块；持久日志需配置 Firestore。[O-Params] [O-Experimental] [O-App] [O-Package] | **适合借鉴记录与标签分离，不适合整套移植为通用检测器。** 当前判题围绕已知答案；开放报告与任意代码项目仍需课程适配器。此项为接入推论。 |
| **Vowpal Wabbit** | 根据上下文选择动作；ADF 支持每次不同的候选动作；IPS/DR 学习及离线策略评估。`cb_explore_adf_greedy.cc`、`gen_cs_example.*`、`cb_algs.cc`。[V-Explore] [V-IPS] [V-DR] [V-Eval-Code] | 决策前上下文、候选动作、已选动作、其真实选择概率、观测 cost/reward → 动作／概率分布；离线评估输出估计损失。 | 需要带结果的历史决策数据与可比较的动作覆盖；示例奖励是人为构造的。CLI/C++ 或 Python binding；该快照 Python 要求 `>=3.10`，源码构建使用 CMake/pybind11。[V-Example] [V-Reward] [V-Build] | **算法接口可通用，教学语义不可免适配。** 能优化已定义的代理结果；不能自己判报告质量、代码学习收获，也不能让无概率／无结果日志自动变成有效 OPE 数据。此项为接入推论。 |

## pyBKT：可作为技能状态部件，不能承担通用困难检测

**源码核验。** `source-py/pyBKT/util/data_helper.py` 要求学生、技能、正确性列；可映射列名，按 `order_id` 和学生稳定排序。外部正确性只能取 `-1`（无响应）、`0`（错误）、`1`（正确），内部再转换编码。`-1` 表示缺少响应，不能作为“学生尚未编辑”“没有点赞”或其他任意消极标签的替代。[P-Input]

`source-py/pyBKT/models/Model.py` 的 `_fit()` 多次初始化后执行 EM，按似然选择参数；`predict()` 返回 DataFrame，新增 `correct_predictions` 与 `state_predictions`。`coef_` 按技能返回 `prior`、`learns`、`guesses`、`slips`、`forgets`；默认 `forgets=False`。`Roster.update_state(skill_name, student_name, correct)` 可消费新响应，返回状态对象，其 `current_state` 包含 `correct_prediction`、`state_prediction`；模型状态阈值不是提示时机的验证阈值。[P-Model] [P-Roster] [P-Predict]

以下只是自拟的输入格式展示，未运行；`correct` 必须来自已定义的观测规则：

```csv
order_id,user_id,skill_name,correct
1,student_a,course_a:bounds_check,0
2,student_a,course_a:bounds_check,1
```

**数据与部署核验。** `tests/helpers.py` 明确按预设学习、猜测、失误与遗忘参数生成合成序列；`tests/test_model_outputs.py` 用这些序列检查模型结果。它们不是跨课程真实学生训练集。`setup.py` 声明 NumPy/pandas/requests；默认尝试 C++ 扩展，失败可回退纯 Python，`PYBKT_REQUIRE_CPP=1` 可禁止回退。此处只核对构建路径，不报告安装成功或平台兼容实测。[P-Fixture] [P-Test] [P-Build]

**接入推论。** 只有当代码检查能定位到某个学习目标、报告量规有可重复判定的证据时，才适合形成 BKT observation。保存文件、运行失败、长时间阅读都不是天然的 `correct=0`。多次复制后通过测试也不等于独立掌握；需保留帮助使用、检查版本和观测来源。BKT 分数既不能证明帮助造成进步，也不能仅因技能名相似就跨课合并状态。

## OATutor：实际事件链路及其边界

**源码核验：观测是正常作答产生的，但仍依赖判题。** `ProblemCard.js` 调用 `checkAnswer()`，将返回值转换为 `isCorrect`，调用 `answerMade()`，随后把 `answerStep` 与掌握度写入 logger。`checkAnswer.js` 对照作者提供的 `stepAnswer`，处理表达式／矩阵、字符串和数值；这不是任意开放作品的评价器。[O-Answer] [O-Grader]

| 正常操作 | 已核对调用／存储路径 | 实际字段与含义 |
| --- | --- | --- |
| 提交步骤答案 | `ProblemCard.js` → `Firebase.log()` → `problemSubmissions` | `eventType=answerStep`，`problemID`、`stepID`、`input`、`correctAnswer`、`isCorrect`、`knowledgeComponents`、`hintsFinished`、`masteryScore`、`kcMastery`。正确性与模型分数同时存在。[O-Answer] [O-Log] |
| 解锁提示／提交支架答案 | `ProblemCard.unlockHint()`、`HintSystem.submitSubHint()` → `log()`／`hintLog()` | `unlockHint`、`unlockSubHint`、`hintScaffoldLog`；支架答案另有 `hintInput`、`hintAnswer`、`hintIsCorrect`。打开提示的记录本身没有“帮助有效”标签。[O-Hint] [O-Log] |
| 开始题目 | `Firebase.startedProblem()` → `problemStartLogs` | 题目、课程内容名、课时、学习目标；可与后续记录关联，但单次开始记录不证明持续困难。[O-Log] |
| 窗口离开／返回 | `TabFocusTracker.js` → `submitFocusChange()` | `focusStatus` 写入按用户、日期分区的 `focusHistory` 数组；只说明焦点变化，不说明注意力或动机。[O-Focus] [O-Log] |

通用 metadata 包含 `oats_user_id`、`treatment`、`time_stamp`、`siteCommitHash` 等；非数组事件另加 `server_time`。`writeData()` 经 Firestore `setDoc()` 写入，未初始化数据库会跳过，写入错误会记录告警。因而**存在日志代码不等于线上日志完整可靠**。`src/tools/firebaseExportCSV.mjs` 提供从 Firestore collection 导出 CSV 的实现，需要有权限的 Firebase 环境；本次没有运行导出或读取生产数据。[O-Log] [O-Export]

**源码核验：BKT 标签不总等于实际正确性。** `src/models/BKT/BKT-brain.js` 只接收模型和 `isCorrect`，用四个概率更新 `probMastery`，没有训练器或帮助效果估计器。`Problem.js` 的首次作答更新路径会把 `helpPenaltyPendingByStep` 转换为 `bktIsCorrect=false`；界面和 `answerStep.isCorrect` 仍保留真正的判题结果。`helpPenaltyMode.js` 提供 `Never`、`AnswerReveal`、`OnOpen`；该快照默认提示为 `OnOpen`、AI 聊天为 `Never`。这是作者定义的“独立作答证据”规则，不能理解为模型发现“提示伤害了学生”。[O-BKT] [O-Update] [O-Penalty]

**静态数据核验：不能把随仓参数称为已拟合。** 主仓库树中的 `src/content-sources/oatutor` gitlink 固定到上述内容 commit；`App.js` 导入其 `defaultBKTParams.json` 和 `experimentalBKTParams.json`。本次解析两份 JSON，各有 **1,252 个 KC**，各项 `probMastery`、`probTransit`、`probSlip`、`probGuess` 均为 **0.1**。已核验路径是“加载参数—保存／恢复学生状态—按作答更新”；未取得这些初值的数据拟合证据或真实学生训练集。[O-Submodule] [O-App] [O-Params] [O-Experimental]

`defaultHeuristic.js` 排除已完成、无关或达到 `MASTERY_THRESHOLD` 的题目，在剩余题中选最低掌握度、同分随机选题；配置中的默认阈值为 `0.85`。这证明有自适应选题规则，**不证明 0.85 是无扰介入时机的有效阈值**。[O-Heuristic] [O-Config]

**接入推论。** 最值得复用的是“操作—评价观测—模型状态”的分层，以及区分实际正确、使用过帮助、模型更新标签。不要照搬帮助惩罚来评估帮助成效；若用被该惩罚直接改变的掌握度作为 bandit reward，会把计分约定当作教学效果。其 logger 已核验字段也不包含逐次介入的候选动作集及选择概率，不能直接拿来做 XunJie 的 IPS/DR。

## Vowpal Wabbit：满足数据条件后再做动作优化

**源码核验。** `vowpalwabbit/core/include/vw/core/cb.h` 的 `cb_class` 包含 `action`、`cost`、`probability`；`has_observed_cost()` 要求 cost 已知且 probability 大于零。这里的 probability 是**收集数据的策略当时选择该动作的概率**，不是模型对“学生困惑”的置信度。[V-Label]

固定动作的输入为 `action:cost:probability | features`。ADF 输入则是一组候选动作，每行动作可带自身特征，`shared` 行承载公共上下文；仅被执行动作一行带 cost/probability，动作由行位置识别，行首 `0` 不是业务动作 ID。以下是自拟的格式展示，`-0.4` 是假设 cost，绝非本次测得的效果：[V-Format]

```text
shared | context mode=reminder course=course_a repeated_failure:2
| action no_op
0:-0.4:0.2 | action reminder

```

`cb_explore_adf_greedy.cc` 将预测转换成动作概率分布；执行方仍需按分布选择、执行并记录结果。动作行顺序／业务 ID 映射与实际抽样概率必须一起保存，不能只保存最高分动作。`gen_cs_example.cc` 的 IPS 路径对观测 cost 做概率倒数加权；`gen_cs_example.h` 的 DR 路径先取得成本预测，再对实际观测动作加上 `(observed_cost - predicted_cost) / probability` 修正。**DR 对未执行动作给出的是估计，不是补获了真实结果。** [V-Explore] [V-IPS] [V-DR]

**离线评估源码与示例核验。** 官方 `off_policy_evaluation.md` 展示时间顺序划分训练／测试数据、用 `-t` 禁止评估时更新策略、读取 `average loss`；还展示在记录前加候选策略动作，通过 `--cb ... --eval` 评估外部策略。`cb_algs.cc` 有相应 `CB_EVAL` 路径，并拒绝用 DM 执行该评估。该教程评估的候选策略不包含整个探索层；不能把输出直接解释为“带探索和连续教学干预的整体收益”。[V-OPE] [V-Eval-Code]

注意不同入口的默认值：已读 `cb_adf.cc` 的 `cb_type` 默认 **`mtr`**，`cb_algs.cc` 的该选项默认 **`dr`**。若要评估 IPS/DR，应显式固定方法和命令，而不是根据教程文字假定所有入口都默认 DR。[V-ADF] [V-Eval-Code]

**数据与部署核验。** Python 示例先手工提供 action、cost、probability 才调用 `learn()`；端到端测试的 `reward_functions.py` 也明确定义人工奖励函数。`setup.py` 声明 Python `>=3.10`、BSD-3-Clause 和 CMake 扩展；源码构建包含 pybind11 配置。它提供学习库／CLI，不替 XunJie 实现事件采集、延迟结果关联、作品判定或学生模式管理。[V-Example] [V-Reward] [V-Build]

**接入推论：以下条件缺失时，OPE 数字不足以支持介入决策。**

- 必须有可靠的观测结果、决策前上下文和真实 logging propensity；日志只记录“系统选择了提醒”不够。不能事后用当前模型推测的概率冒充当时概率。
- 待评估动作须在相同许可与上下文范围内有数据支持。历史策略从不提醒的情境，不能靠给零概率加一个小数就证明提醒有效；源码的数值保护不创造缺失证据。
- 极小概率会造成大权重和高方差；应报告覆盖、有效样本与不确定性。丢失结果、未完成观察窗口应标成未知／删失，不能直接写成失败或零奖励。
- 一次提交变好可能来自自然练习、其他帮助或题目变化。即使 OPE 条件满足，它评估的也是所定义的结果指标和数据人群；延迟迁移、长期学习与单个学生的因果受益仍需另行验证。[V-OPE] [V-IPS] [V-DR]

## 给主线的五条接入判断

1. **先复用 OATutor 的证据分层，不照搬其题型与帮助惩罚。** 正常操作可以减少主动询问，但需分别保留 `raw_event`、有来源的任务结果、帮助使用与模型估计。报告、代码各自定义可判定的结果；文件保存、提示打开、切换窗口只作上下文。
2. **pyBKT 只进入已有清晰 KC 和可靠响应观测的课程局部。** 优先用于可解释的技能状态候选信号；开放作品没有可靠标签时保持未知。持续困难与介入时机仍需结合当前任务证据，不把低掌握度单独升级为主动打断。
3. **学生选择应在模型外形成硬动作边界。** 「仅提问」和暂停主动教学时，主动决策只允许 `no_op`；「适时提醒」与「更多引导」分别限定各自允许动作，并保留不介入选项。先过滤再抽样，记录过滤后的实际概率；执行前再次核对当前选择，失效决策取消。探索不得越界。
4. **帮助后的正常行为先当作候选效果证据。** 例如有效错误减少、独立检查通过、量规缺项补齐；定义观察窗口、任务版本和帮助暴露后，才可形成代理 reward。点击／继续停留不自动等于有帮助，学生不回应也不是负奖励；BKT 后验变化更不是独立效果标签。
5. **VW 留到结果闭环和概率日志具备以后；先做离线候选评估。** 跨课只复用学生明确声明为通用的偏好；课程困难、掌握度、效果标签与学到的策略先按课程／任务范围隔离。多课程共享数据或参数属于额外迁移假设，须另验证，不能由通用 feature 接口自动获得授权或有效性。

以上五项属于接入推论；负责人随后已确认[主提案中的首版路线](2026-10-23-proactive-guidance-proposal.md)，采用范围以[确认记录](https://github.com/paher-din/XunJie/issues/118#issuecomment-6364167173)为准，不表示整体移植以上项目或已证实教学有效。主线已有本地事件审计，本文不重复断言 XunJie 当前已经具备这些输入。

## 证据索引与未执行项

所有实现依据均来自上述固定 SHA 的官方原始文件；未凭 README 推断模型效果。OATutor-Content 的许可声明来自其 README，参数结论来自实际 JSON。检索后未扩大到其他实现，也未为维护活跃度继续追查。本文无算法运行结果；上游示例输出、测试文件与断言均不计为本次通过。仅做文档格式和来源对应检查，没有产生需要保留的临时克隆或下载文件。

[P-License]: https://github.com/CAHLR/pyBKT/blob/9bfeb31c09ea63c5962afc06b3935b5eefb4029e/LICENSE
[P-Input]: https://github.com/CAHLR/pyBKT/blob/9bfeb31c09ea63c5962afc06b3935b5eefb4029e/source-py/pyBKT/util/data_helper.py#L53-L169
[P-Model]: https://github.com/CAHLR/pyBKT/blob/9bfeb31c09ea63c5962afc06b3935b5eefb4029e/source-py/pyBKT/models/Model.py
[P-Roster]: https://github.com/CAHLR/pyBKT/blob/9bfeb31c09ea63c5962afc06b3935b5eefb4029e/source-py/pyBKT/models/Roster.py#L519-L593
[P-Predict]: https://github.com/CAHLR/pyBKT/blob/9bfeb31c09ea63c5962afc06b3935b5eefb4029e/source-py/pyBKT/fit/predict_onestep.py
[P-Fixture]: https://github.com/CAHLR/pyBKT/blob/9bfeb31c09ea63c5962afc06b3935b5eefb4029e/tests/helpers.py
[P-Test]: https://github.com/CAHLR/pyBKT/blob/9bfeb31c09ea63c5962afc06b3935b5eefb4029e/tests/test_model_outputs.py#L25-L44
[P-Build]: https://github.com/CAHLR/pyBKT/blob/9bfeb31c09ea63c5962afc06b3935b5eefb4029e/setup.py
[O-License]: https://github.com/CAHLR/OATutor/blob/e24c8456e5f75c07b6048159ea9e128b036f673d/LICENSE
[O-Submodule]: https://github.com/CAHLR/OATutor/tree/e24c8456e5f75c07b6048159ea9e128b036f673d/src/content-sources
[O-Content-License]: https://github.com/CAHLR/OATutor-Content/blob/1925decc91567faf6203bdb41b9d52b14891426f/README.md
[O-Params]: https://github.com/CAHLR/OATutor-Content/blob/1925decc91567faf6203bdb41b9d52b14891426f/bkt-params/defaultBKTParams.json
[O-Experimental]: https://github.com/CAHLR/OATutor-Content/blob/1925decc91567faf6203bdb41b9d52b14891426f/bkt-params/experimentalBKTParams.json
[O-App]: https://github.com/CAHLR/OATutor/blob/e24c8456e5f75c07b6048159ea9e128b036f673d/src/App.js#L43-L79
[O-Package]: https://github.com/CAHLR/OATutor/blob/e24c8456e5f75c07b6048159ea9e128b036f673d/package.json
[O-Answer]: https://github.com/CAHLR/OATutor/blob/e24c8456e5f75c07b6048159ea9e128b036f673d/src/components/problem-layout/ProblemCard.js#L323-L388
[O-Grader]: https://github.com/CAHLR/OATutor/blob/e24c8456e5f75c07b6048159ea9e128b036f673d/src/platform-logic/checkAnswer.js#L93-L200
[O-Hint]: https://github.com/CAHLR/OATutor/blob/e24c8456e5f75c07b6048159ea9e128b036f673d/src/components/problem-layout/HintSystem.js#L151-L222
[O-BKT]: https://github.com/CAHLR/OATutor/blob/e24c8456e5f75c07b6048159ea9e128b036f673d/src/models/BKT/BKT-brain.js#L1-L14
[O-Update]: https://github.com/CAHLR/OATutor/blob/e24c8456e5f75c07b6048159ea9e128b036f673d/src/components/problem-layout/Problem.js#L653-L748
[O-Penalty]: https://github.com/CAHLR/OATutor/blob/e24c8456e5f75c07b6048159ea9e128b036f673d/src/util/helpPenaltyMode.js
[O-Log]: https://github.com/CAHLR/OATutor/blob/e24c8456e5f75c07b6048159ea9e128b036f673d/src/components/Firebase.js
[O-Focus]: https://github.com/CAHLR/OATutor/blob/e24c8456e5f75c07b6048159ea9e128b036f673d/src/components/TabFocusTracker.js
[O-Export]: https://github.com/CAHLR/OATutor/blob/e24c8456e5f75c07b6048159ea9e128b036f673d/src/tools/firebaseExportCSV.mjs#L91-L108
[O-Heuristic]: https://github.com/CAHLR/OATutor/blob/e24c8456e5f75c07b6048159ea9e128b036f673d/src/models/BKT/problem-select-heuristics/defaultHeuristic.js#L1-L20
[O-Config]: https://github.com/CAHLR/OATutor/blob/e24c8456e5f75c07b6048159ea9e128b036f673d/src/config/config.js#L114-L120
[V-License]: https://github.com/VowpalWabbit/vowpal_wabbit/blob/00196b35f63bcb8a6d66966e2b4cf67d6a2bd335/LICENSE
[V-Label]: https://github.com/VowpalWabbit/vowpal_wabbit/blob/00196b35f63bcb8a6d66966e2b4cf67d6a2bd335/vowpalwabbit/core/include/vw/core/cb.h#L19-L37
[V-Format]: https://github.com/VowpalWabbit/vowpal_wabbit/blob/00196b35f63bcb8a6d66966e2b4cf67d6a2bd335/python/docs/source/tutorials/python_Contextual_bandits_and_Vowpal_Wabbit.ipynb
[V-Example]: https://github.com/VowpalWabbit/vowpal_wabbit/blob/00196b35f63bcb8a6d66966e2b4cf67d6a2bd335/python/docs/source/examples/contextual_bandit.ipynb
[V-Explore]: https://github.com/VowpalWabbit/vowpal_wabbit/blob/00196b35f63bcb8a6d66966e2b4cf67d6a2bd335/vowpalwabbit/core/src/reductions/cb/cb_explore_adf_greedy.cc#L49-L81
[V-IPS]: https://github.com/VowpalWabbit/vowpal_wabbit/blob/00196b35f63bcb8a6d66966e2b4cf67d6a2bd335/vowpalwabbit/core/src/gen_cs_example.cc#L13-L39
[V-DR]: https://github.com/VowpalWabbit/vowpal_wabbit/blob/00196b35f63bcb8a6d66966e2b4cf67d6a2bd335/vowpalwabbit/core/include/vw/core/gen_cs_example.h#L213-L245
[V-ADF]: https://github.com/VowpalWabbit/vowpal_wabbit/blob/00196b35f63bcb8a6d66966e2b4cf67d6a2bd335/vowpalwabbit/core/src/reductions/cb/cb_adf.cc#L437-L454
[V-Eval-Code]: https://github.com/VowpalWabbit/vowpal_wabbit/blob/00196b35f63bcb8a6d66966e2b4cf67d6a2bd335/vowpalwabbit/core/src/reductions/cb/cb_algs.cc
[V-OPE]: https://github.com/VowpalWabbit/vowpal_wabbit/blob/00196b35f63bcb8a6d66966e2b4cf67d6a2bd335/python/docs/source/tutorials/off_policy_evaluation.md
[V-Reward]: https://github.com/VowpalWabbit/vowpal_wabbit/blob/00196b35f63bcb8a6d66966e2b4cf67d6a2bd335/python/tests/e2e_v2/cb/reward_functions.py
[V-Build]: https://github.com/VowpalWabbit/vowpal_wabbit/blob/00196b35f63bcb8a6d66966e2b4cf67d6a2bd335/setup.py
