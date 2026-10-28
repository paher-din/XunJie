# 主动引导的用户控制与反馈适应

核查日期：2026-10-23；服务于[跨课程连续教学：主动引导、活动进展、学习证据与学生画像](https://github.com/paher-din/XunJie/issues/118)。沿用本轮确认的教师最终确认课程设计、基于证据轻度主动且可忽略。以下工程推论均为候选，不替负责人选择默认值或实验策略。

**1. 用户控制。来源事实：** HAX 支持忽略或关闭单次帮助（G8）、单次反馈（G15）与全局控制（G17），明确区分后两者。[S1] **工程推论：** 主动性设置、暂时安静和单次拒绝应分别表达，自动适应不能越过显式设置。**未验证：** 哪种控制粒度最易理解。

**2. 显式与隐式反馈。来源事实：** HAX 建议从行为学习并说明操作后果；MRT 论文用自报补充、消歧被动记录。[S1]、[S4] **工程推论：** “太频繁”“时机不对”“内容无用”有不同语义；点击、停留和沉默只是行为，沉默可能来自忙碌或未看到。反馈须保留对象、时间与活动上下文；满意也不等于掌握。**未验证：** 各信号的可靠性及反馈负担。

**3. 适应与渐进更新。来源事实：** G14 建议限制破坏性变化；MRT 在决策点重复随机分配干预，估计时变近端效应，并考虑延迟效应和负担。[S1]、[S4] **工程推论：** 明示设置立即执行，推断偏好小步调整、可撤销，避免一次忽略永久改变主动性。**未验证：** 更新速度、证据门槛和跨任务稳定性；MRT 是研究方法，不是在线自学习算法。

**4. 互动率的边界。来源事实：** assistance dilemma 指提供与保留帮助的最优平衡仍待研究；Roll 等研究1（58名几何学生）改善了求助行为，却未检出额外学科增益。[S2]、[S3] **工程推论：** 回复可能只是应付打断，互动率只能作过程指标，须并看独立表现、迁移或保持、打扰感与控制感。**未验证：** 这些指标在循阶各课程的效度。

| 来源 | 年份与原始文献 | 核查位置与边界 |
| --- | --- | --- |
| S1 | Amershi et al., **2019**, [Guidelines for Human-AI Interaction][S1] | 表1、G15/G17 澄清段落；49名设计从业者评估20款产品，非教学效果试验。 |
| S2 | Koedinger & Aleven, **2007**, [Exploring the Assistance Dilemma in Experiments with Cognitive Tutors][S2] | 出版社摘要；问题原始论述与既有实验重析，非新增试验。 |
| S3 | Roll et al., **2011**, [Improving students’ help-seeking skills using metacognitive feedback in an intelligent tutoring system][S3] | §2.3.2，p.274；几何教学原始实验。 |
| S4 | Klasnja et al., **2015**, [Microrandomized Trials: An Experimental Design for Developing Just-in-Time Adaptive Interventions][S4] | pp.1222–1224；移动健康干预方法论文。 |

[S1]: https://www.microsoft.com/en-us/research/wp-content/uploads/2019/01/Guidelines-for-Human-AI-Interaction-camera-ready.pdf
[S2]: https://link.springer.com/article/10.1007/s10648-007-9049-0
[S3]: https://pact.cs.cmu.edu/pubs/Roll%2C%20Aleven%2C%20McLaren%20%26%20Koedinger%202011.pdf
[S4]: https://www.ambujtewari.com/research/klasnja15microrandomized.pdf

以上未验证循阶效果；几何教学与移动健康结果不能直接推广到跨课程 Agent。下列是可检验的工程推论，不是已通过的验收：

1. 关闭主动帮助后，不再自动推送，仍可主动求助。
2. 单次拒绝与全局设置分别保存，不互相覆盖。
3. 未展示、未回应、明确拒绝分别记录；沉默不直接写成偏好或掌握判断。
4. 回放同一事件序列，可追溯调整依据；显式设置优先，推断调整可撤销。
5. 反馈可区分频率、时机、内容，并显示影响范围。
6. 互动率注明展示基数，并同时报告独立学习表现和主观打扰；互动率上升不能单独判为改善。
