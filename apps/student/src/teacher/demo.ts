import type { DesignDraft, TeacherData } from './types'

// Only imported by the development-only preview entry. Never used as an API fallback.
export const previewDraft: DesignDraft = {
  id: 'draft-report', courseId: 'preview-c', title: 'TextScope Report · 让文本成为报告',
  problem: '为校园读书小组制作一个可重复使用的文本分析工具，把多份 ASCII 文本中的信息组织成一份可核查的报告。',
  audience: '校园读书小组与课程同学', deliverable: 'C 源码、公开测试文本、一份包含文件统计与词频的报告，以及简短设计说明。',
  choices: '自主选择动态数组、链表、树或哈希结构；比较实现复杂度与查询效率，说明自己的取舍。',
  foundation: '已学习函数、数组、指针与文件操作，完成 TextScope Core。', duration: '两次课内实践与一次课后修订',
  goals: [
    { id: 'g1', domain: 'domain', title: '解释文件处理与动态数据结构', evidence: '结合代码说明文件边界、内存分配与释放，并验证空文件。' },
    { id: 'g2', domain: 'project', title: '基于反例比较与修订方案', evidence: '保留一个反例、一次方案比较和相应修订说明。' },
    { id: 'g3', domain: 'ai_collaboration', title: '核查并调整 AI 的建议', evidence: '引用一次建议及自己的核查过程，说明采用或拒绝的理由。' },
  ],
  milestones: [
    { id: 'm1', title: '定义报告与验证计划', evidence: '报告草图、边界用例与结构选择说明' },
    { id: 'm2', title: '实现并核查报告', evidence: '固定源码快照、运行产物与反例结果' },
    { id: 'm3', title: '交付、反馈与修订', evidence: '作品提交、简短反思与修订说明' },
  ],
  rubric: [
    { id: 'r1', criterion: '作品表现', description: '报告内容、数值、排序和输入覆盖范围符合活动要求；运行结果可追溯。' },
    { id: 'r2', criterion: '设计与验证', description: '说明数据结构选择，使用边界用例验证，并解释修订依据。' },
    { id: 'r3', criterion: '协作与核查', description: '能指出 AI 建议的适用条件，以实际检查支持自己的决定。' },
  ],
  helpPolicy: '允许概念解释、局部提示与相邻示例。保护当前任务的关键思考，不提供可直接提交的完整答案。必要检查点遵守课程限定帮助政策。',
  resourceIds: ['res-c-guide', 'res-c-reference'], revision: 3, savedAt: '2026-10-15T02:20:00Z',
}

export function createPreviewData(): TeacherData {
  return {
    courses: [
      { id: 'preview-c', title: 'C 程序设计', code: 'CS 101', term: '2026 秋季学期', kind: 'c' },
      { id: 'preview-hdl', title: '数字逻辑与部件设计', code: 'CS 203', term: '2026 秋季学期', kind: 'hdl' },
    ],
    activities: [
      { id: 'activity-core', courseId: 'preview-c', title: 'TextScope Core', description: '从一份文本出发，探索统计、检索与词频分析。', status: 'active', version: 2, assigned: 3, submitted: 2, reviewed: 1, due: '10 月 22 日' },
      { id: 'activity-alu', courseId: 'preview-hdl', title: '4 位 ALU · 从逻辑到电路', description: '设计、构建与虚拟装载，观察输入如何成为真实输出。', status: 'active', version: 1, assigned: 3, submitted: 1, reviewed: 0, due: '10 月 24 日' },
    ],
    drafts: [structuredClone(previewDraft)],
    resources: [
      { id: 'res-c-guide', courseId: 'preview-c', title: 'TextScope 项目说明', kind: 'learning', content: '# TextScope\n\n为公开 ASCII 文本编写统计、完整词检索与多文件词频工具。\n\n## 验证建议\n\n从空文件、单词边界与重复词开始，解释你选择的数据结构。\n\n此正文为隔离 UI 预览材料。', source: '课程自编材料 · 合成预览', student: true, tutor: true, teacherDesign: true, version: 1 },
      { id: 'res-c-reference', courseId: 'preview-c', title: '文件与内存操作参考', kind: 'reference', content: '合成课程参考：核查 fopen/fclose 配对、分配失败和空输入的处理。参考材料不替代学生的实现和判断。', source: '课程自编参考 · 合成预览', student: true, tutor: true, teacherDesign: true, version: 1 },
      { id: 'res-c-private', courseId: 'preview-c', title: '教师验收与反例说明', kind: 'private_answer', content: '仅供教师查看的合成评价说明。不得传给学生或辅导 Agent。\n\n作品正确性与学科、项目、协作三条能力线分别评价，缺少观察保持未知。', source: '教师自编 · 合成预览', student: false, tutor: false, teacherDesign: false, version: 1 },
      { id: 'res-hdl-guide', courseId: 'preview-hdl', title: '4 位 ALU 实验任务书', kind: 'learning', content: '合成预览说明：实现课程已定义的 4 位 ALU 操作，在虚拟板卡观察输出。结果绑定确切源码、构建与会话版本。\n\n本预览不包含实际执行环境。', source: '课程实验说明 · 合成预览', student: true, tutor: true, teacherDesign: true, version: 1 },
    ],
    learners: [
      { id: 'learner-lin', name: '林同学', courseId: 'preview-c', activityId: 'activity-core', activityTitle: 'TextScope Core', status: 'submitted', route: '动态数组', updated: '今天 09:42', submission: 'submission-001', version: 4,
        evidence: [
          { id: 'ev-lin-code', type: '作品', title: '边界条件与文件读取', source: 'main.c · 快照 v4 · 第 24–32 行', assistance: '已观察到概念提示', text: 'while (fgets(line, sizeof(line), fp)) {\n    count_words(line, &stats);\n}\nif (ferror(fp)) {\n    fprintf(stderr, "read failed\\n");\n}\nfclose(fp);' },
          { id: 'ev-lin-run', type: '运行记录', title: '空文件与单词边界测试', source: 'run-001 · 快照 v4', assistance: '本系统内未观察到该次检查的额外帮助；外部帮助未知', text: '课程检查：空文件、连续空白与词边界用例通过。\n这是固定规则下的作品检查，不代表独立掌握。' },
          { id: 'ev-lin-self', type: '学生自述', title: '关于方案的选择', source: '提交说明 · submission-001', assistance: '自述不作为独立能力证明', text: '我选择动态数组，因为输入量不大，扩容逻辑比较清楚。我检查了空文件，但还没有比较大文件下不同结构的速度。' },
          { id: 'ev-lin-help', type: '辅导消息', title: '如何核查文件读取结束', source: 'message-001 · 快照 v3', assistance: 'Agent 概念解释，已展示', text: '核对读取循环结束的两种原因：读到文件末尾与发生读取错误。你会用哪一个库函数区分？' },
        ],
        claims: [
          { id: 'claim-lin-1', domain: '学科知识', text: '能在受助条件下处理文件读取与空输入边界。', state: 'supported_with_assistance', evidenceIds: ['ev-lin-code', 'ev-lin-run', 'ev-lin-help'] },
          { id: 'claim-lin-2', domain: '项目能力', text: '已给出结构选择理由；大输入下的比较尚缺依据。', state: 'insufficient', evidenceIds: ['ev-lin-self'] },
          { id: 'claim-lin-3', domain: 'AI 协作', text: '收到提示后进行了核查，建议取舍的解释尚不完整。', state: 'insufficient', evidenceIds: ['ev-lin-help', 'ev-lin-run'] },
        ], unknowns: ['未观察到大文件性能比较。', '系统以外的帮助条件未知。'], feedback: '', decision: '', revisionAllowed: false },
      { id: 'learner-zhou', name: '周同学', courseId: 'preview-c', activityId: 'activity-core', activityTitle: 'TextScope Core', status: 'reviewed', route: '哈希表', updated: '昨天 16:28', submission: 'submission-002', version: 3, evidence: [{ id: 'ev-zhou', type: '作品', title: '词频排序结果', source: '快照 v3 · run-002', assistance: '已观察到局部提示', text: '多文件词频结果已按次数和词典序核查；内存释放还需补充边界用例。' }], claims: [], unknowns: ['内存失败路径尚未验证。'], feedback: '作品的词频与排序结果可追溯。请补充内存分配失败时的处理说明，再比较另一种结构的取舍。', decision: '确认当前作品结果，后续补充边界证据。', revisionAllowed: true },
      { id: 'learner-chen', name: '陈同学', courseId: 'preview-c', activityId: 'activity-core', activityTitle: 'TextScope Core', status: 'active', route: '链表', updated: '今天 10:06', submission: '', version: 2, evidence: [], claims: [], unknowns: ['尚未提交作品。'], feedback: '', decision: '', revisionAllowed: false },
      { id: 'learner-xu', name: '许同学', courseId: 'preview-hdl', activityId: 'activity-alu', activityTitle: '4 位 ALU', status: 'submitted', route: '组合逻辑', updated: '今天 10:18', submission: 'submission-004', version: 5, evidence: [{ id: 'ev-xu', type: '作品', title: 'ALU 构建与仿真结果', source: 'alu.sv · 快照 v5 · build-004', assistance: '已观察到信号核查提示', text: '合成 UI 示例：已定义运算的输出与输入关联可追溯。波形显示了相应输入和输出；不把仿真通过作为实体时序验收。' }], claims: [{ id: 'claim-xu', domain: '学科知识', text: '能够依据波形解释已定义操作的输入输出。', state: 'supported_with_assistance', evidenceIds: ['ev-xu'] }], unknowns: ['未定义的 Cout 不判分。', '实体 FPGA 时序未验证。'], feedback: '', decision: '', revisionAllowed: false },
      { id: 'learner-wu', name: '吴同学', courseId: 'preview-hdl', activityId: 'activity-alu', activityTitle: '4 位 ALU', status: 'active', route: '组合逻辑', updated: '今天 09:56', submission: '', version: 2, evidence: [], claims: [], unknowns: ['尚未提交作品。'], feedback: '', decision: '', revisionAllowed: false },
      { id: 'learner-he', name: '何同学', courseId: 'preview-hdl', activityId: 'activity-alu', activityTitle: '4 位 ALU', status: 'paused', route: '组合逻辑', updated: '昨天 15:20', submission: '', version: 1, evidence: [], claims: [], unknowns: ['尝试已暂停。'], feedback: '', decision: '', revisionAllowed: false },
    ],
  }
}
