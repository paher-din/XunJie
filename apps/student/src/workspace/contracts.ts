/**
 * 后端 HTTP 契约的**可序列化投影**。
 *
 * 来源（只读核对，不导入服务端模块，不把后台代码打进浏览器）：
 * - 信封与错误码：`apps/teaching/contracts/common/http.ts`
 * - Session / Assignment / Activity / Resource 视图：`apps/teaching/contracts/design/results.ts`
 *   （`activityViewSchema`、`assignmentViewSchema`、`projectedMaterialSchema`）
 * - student 视角裁剪规则：`apps/teaching/server/design/projection.ts`
 * - 内容字段：`apps/teaching/contracts/design/draft.ts` 的 `contentShape`
 * - Attempt 只读视图：`apps/teaching/contracts/workspace/index.ts`、
 *   `apps/teaching/server/workspace/commands.ts` 的 `readWorkspace`
 *
 * 本文件只声明 01 需要的读取投影。字段名与服务端 schema 逐字一致；服务端未公开的字段
 * 不在此补造（例如 GET Run 不公开 entryFileId/input，见 CLIENT_CONTRACT §6）。
 */

import type { HdlActivityExecution } from './hdlActivityContracts'

/* ---------- 统一信封 ---------- */

export interface SuccessEnvelope<T> {
  requestId: string
  data: T
}

/** `apps/teaching/contracts/common/http.ts` 的 errorDefinitions 键集合。 */
export type ApiErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'STATE_CONFLICT'
  | 'RECOVERY_REQUIRED'
  | 'CONTENT_LIMIT'
  | 'INVALID_REFERENCE'
  | 'INVALID_CONFIGURATION'
  | 'RUNTIME_NOT_READY'
  | 'RATE_LIMITED'
  | 'BUDGET_EXHAUSTED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'PERSISTENCE_UNAVAILABLE'

export interface ApiErrorBody {
  code: ApiErrorCode
  message: string
  retryable: boolean
  recovery: string
}

export interface ErrorEnvelope {
  requestId: string
  error: ApiErrorBody
}

/* ---------- 会话（A1） ---------- */

export type CourseRole = 'teacher' | 'student'

/** GET `/api/session` 的 `data`。 */
export interface SessionView {
  userId: string
  displayName?: string
  courses: Array<{ courseId: string; role: CourseRole; name?: string }>
  csrfToken: string
}

/** POST `/api/sessions` 的 `data`；会话 cookie 由服务端 Set-Cookie 下发，不经浏览器 JS。 */
export interface SessionCreatedView {
  csrfToken: string
}

/** POST `/api/logout` 的 `data`。 */
export interface LogoutView {
  loggedOut: true
}

/* ---------- 分配与活动（A2） ---------- */

/** GET `/api/assignments/:id` 的 `data`（`assignmentViewSchema`）。 */
export interface AssignmentView {
  assignmentId: string
  displayTitle?: string
  activityVersionId: string
  studentId: string
  assignmentRevision: number
  /** 分配与活动控制都为 active 时才为 true。 */
  active: boolean
  status: 'active' | 'paused'
  reasons: { individual: string; activity: string }
  activityControlRevision: number
}

/** 固定 I0 宿主 GET `/api/assignments/:id/bootstrap`；授权深链读取，不发现/创建 Attempt。 */
export interface AssignmentBootstrapView {
  assignment: AssignmentView
  recoveryGeneration: string
}

export type CompetencyDomain = 'domain' | 'project' | 'ai_collaboration'

export interface GoalRef {
  competencyId: string
  competencyVersion: number
}

export interface ActivityGoal extends GoalRef {
  domain: CompetencyDomain
  title: string
  core: boolean
}

export interface ActivityTask {
  taskId: string
  title: string
  goalRefs: GoalRef[]
}

export interface ActivityObservation {
  observationId: string
  description: string
  goalRefs: GoalRef[]
  taskIds: string[]
}

export interface ActivityRubricCriterion {
  criterionId: string
  description: string
  goalRefs: GoalRef[]
  observationIds: string[]
}

export interface ActivityMilestone {
  milestoneId: string
  title: string
  taskIds: string[]
}

/**
 * student 视角的活动正文（`projectedContent`）。
 * 服务端 pick 掉了 `checkRuleVersionId` 与 `runtimeProfileVersionId`；
 * `runtimeProfileVersionId` 只在 ActivityView 顶层出现，不在正文里。
 */
export interface ActivityContent {
  projectTitle: string
  problem: string
  audience: string
  artifact: string
  studentBackground: string
  timeConstraints: string
  routes: string[]
  goals: ActivityGoal[]
  tasks: ActivityTask[]
  observations: ActivityObservation[]
  rubricCriteria: ActivityRubricCriterion[]
  milestones: ActivityMilestone[]
  helpPolicyVersionId: string
}

export interface MaterialParagraph {
  /** student 投影下可选：服务端仅在原段落带 ID 时输出。 */
  paragraphId?: string
  ordinal: number
  start: number
  end: number
  text: string
  contentHash: string
}

/**
 * 活动视图里的一条材料。redacted / unavailable 时服务端**不输出任何 ID、标题或正文**，
 * 客户端不得补造（projection.ts:40-49）。
 */
export type ProjectedMaterial =
  | {
      status: 'available'
      resourceVersionId: string
      title: string
      text: string
      contentHash: string
      paragraphs: MaterialParagraph[]
    }
  | { status: 'redacted' }
  | { status: 'unavailable' }

export type ActivityAudience = 'student' | 'tutor' | 'teacher-validator'

export interface HelpPolicyView {
  versionId: string
  helpAllowed: boolean
  wholeSolutionAllowed: false
  limitedCheckHelpAllowed: false
  description: string
}

/** GET `/api/activities/:id?audience=student` 的 `data`（`activityViewSchema`）。 */
export interface ActivityView {
  activityVersionId: string
  courseId: string
  /** 仅 teacher 视角出现；student 投影下缺省。 */
  sourceRevision?: number
  activityControlRevision: number
  status: 'active' | 'paused'
  content: {
    audience: ActivityAudience
    content: ActivityContent
    materials: ProjectedMaterial[]
  }
  helpPolicy: HelpPolicyView
  runtimeProfileVersionId: string
  execution?: HdlActivityExecution
}

/** GET `/api/resources/:id` 的 `data`（student 视角 = `projectedMaterialSchema`）。 */
export interface ResourceStudentView {
  status: 'available'
  resourceVersionId: string
  title: string
  text: string
  contentHash: string
  paragraphs: MaterialParagraph[]
}

/* ---------- 准备 bootstrap（开发 fixture 专用，不是正式 API） ---------- */

/**
 * GET `/__i0prep/context` 的 `data`。
 *
 * 这是开发 fixture 的配置入口，**不是拟定的正式接口**：这些字段不得塞进真实
 * GET Session / Assignment / Activity 的投影，真实初始化按 H-01～H-04 的已交接来源取得。
 */
export interface PrepContextView {
  /**
   * 合成场景 ID。01 只有一个固定合成场景（每个开发进程一个），供准备入口与浏览器检查使用；
   * 「每个测试/浏览器上下文选独立场景 ID」随 04 的故障与恢复脚本一并落地（见任务记录缺口）。
   */
  scenarioId: string
  /** 开发进程重启即换代的准备 epoch。 */
  preparationEpoch: string
  /** 合成受信 recoveryGeneration；仅准备模式有效，不是真实代际来源（H-03）。 */
  recoveryGeneration: string
  /** 合成账号与登录口令（开发专用，非真实凭据）。 */
  syntheticAccount: { loginName: string; password: string; userId: string; courseId: string }
  /** 获准的合成对象引用；真实模式不得硬编码或遍历猜测对应 ID（H-02）。 */
  refs: {
    assignmentId: string
    activityVersionId: string
    resourceVersionIds: string[]
    /** 开发 authority 已有尝试的获准引用；缺省表示尚未创建。不是正式发现 API。 */
    attemptId?: string
  }
  /** 准备 fixture 声明的能力边界，供界面如实显示「待接入」。 */
  capabilities: {
    attemptCreate: boolean
    workspaceSync: boolean
    snapshot: boolean
    run: boolean
  }
  /** 开发进程当前 authority 状态；进程重启即换代，用于核对迟到响应与旧缓存。 */
  authority: {
    preparationEpoch: string
    recoveryGeneration: string
    activeSessions: number
  }
}
