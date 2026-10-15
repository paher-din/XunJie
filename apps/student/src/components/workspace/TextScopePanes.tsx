import { Icon, IconText } from '../../icons'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { describeFailure } from '../../workspace/http'
import { reportDiagnostic } from '../../workspace/diagnostics'
import type { MaterialRead, WorkspaceInit } from '../../workspace/init'
import { PREP_ENTRY_COURSE, PREP_ENTRY_NOTE } from '../../workspace/prepEntry'
import { PREP_BUILD } from '../../workspace/mode'

/**
 * I0-A 准备场景在既有中心容器与阅读位置里的内容块。
 *
 * 只复用已交付的容器（左侧胶囊「任务信息」、中心标签页、顶栏运行簇），不新造页面或导航。
 * 全部数据来自初始化读取的实际 HTTP 响应；读不到就如实显示不可用条件，不补正文、
 * 不宣称已可保存（编辑属 02，保存/快照属 03，运行属 06）。
 */

type ReadyInit = Extract<WorkspaceInit, { kind: 'ready' }>

/* ---------- 中心「设计」标签：C 正文区 ---------- */

export function TextScopeBodyPane({ init, onReload }: { init: WorkspaceInit | null; onReload: () => void }) {
  if (init === null) return <div className="ts-pane"><InitLoading /></div>
  if (init.kind !== 'ready') {
    return (
      <div className="ts-pane">
        <InitUnavailable init={init} onReload={onReload} />
      </div>
    )
  }
  const { activity, context } = init
  return (
    <div className="ts-pane">
      <header className="ts-pane-head">
        <IconText name="code-square" tone="neutral">{activity.execution?.kind === 'hdl_board' ? 'HDL 正文区' : 'C 正文区'}</IconText>
        <span className="ts-pending-pill">{init.assignment.active ? '先开始 Attempt' : '分配已暂停'}</span>
      </header>
      <p className="ts-pane-lead">
        {init.assignment.active ? '点击顶栏“开始 Attempt”进入多文件编辑。' : '当前分配已暂停，可以阅读活动与资料。'}载入只读取活动与资料，
        <b>不会自动创建作品或发送保存请求</b>。
      </p>
      <dl className="ts-facts">
        <Fact label="活动版本 ID" value={activity.activityVersionId} />
        <Fact label="运行时 profile" value={activity.runtimeProfileVersionId} />
        <Fact label="课程" value={activity.courseId} />
        <Fact label="活动状态" value={`${activity.status} · 控制版本 ${activity.activityControlRevision}`} />
        <Fact label="分配状态" value={`${init.assignment.status} · active=${String(init.assignment.active)} · 分配版本 ${init.assignment.assignmentRevision}`} />
        <Fact label="Attempt" value="尚未进入（由学生明确开始或恢复）" />
        <Fact label="受信 recoveryGeneration" value={context.trustedRecoveryGeneration ?? '缺失（不得发送写命令，H-03）'} />
        <Fact label="loadEpoch" value={String(context.loadEpoch)} />
      </dl>
      <CapabilityList init={init} />
    </div>
  )
}

function CapabilityList({ init }: { init: ReadyInit }) {
  const caps = init.prepContext?.capabilities
  if (!caps) return null
  const rows: Array<[string, boolean, string]> = [
    ['创建 Attempt', caps.attemptCreate, '03'],
    ['确认保存（sync）', caps.workspaceSync, '03'],
    ['冻结快照', caps.snapshot, '03'],
    ['发起运行', caps.run, '06'],
  ]
  return (
    <section className="ts-caps">
      <h3>当前准备 fixture 声明的能力边界</h3>
      <ul>
        {rows.map(([label, enabled, ticket]) => (
          <li key={label}>
            <Icon name={enabled ? 'check-circle' : 'lock-keyhole'} size={14} tone="neutral" />
            <span>{label}</span>
            <b>{enabled ? '可用' : `未接入 · 待 ${ticket}`}</b>
          </li>
        ))}
      </ul>
    </section>
  )
}

/* ---------- 顶栏运行簇 ---------- */

export function TextScopeRunCluster({ init }: { init: WorkspaceInit | null }) {
  if (init === null || init.kind !== 'ready') {
    return (
      <span className="ws-run-state" data-state={init === null ? 'loading' : 'unavailable'}>
        <i />
        <span>{init === null ? '初始化读取中' : '初始化未完成'}</span>
      </span>
    )
  }
  return (
    <>
      <span className="ws-run-state" data-state="prep">
        <i />
        <span>{PREP_BUILD ? 'C 准备 · 未运行' : 'C 工作区 · 未运行'}</span>
      </span>
      <span className="ws-flow" title="载入只读取活动和资料，不自动开始或运行">
        <span className="ws-flow-node draft">
          <i />
          只读载入
        </span>
        <span className="ws-flow-link">▸</span>
        <span className="ws-flow-node">学生确认保存</span>
        <span className="ws-flow-link">▸</span>
        <span className="ws-flow-node">学生发起运行</span>
      </span>
    </>
  )
}

/* ---------- 左侧胶囊「任务信息」 ---------- */

export function PrepTaskInfo({ init, onReload }: { init: WorkspaceInit | null; onReload: () => void }) {
  // 标题取自活动响应的 projectTitle；还没读到（载入中 / 不可用）时只显示导航用的准备入口名，
  // 不预先写死活动内容。
  const title = init?.kind === 'ready' ? init.activity.content.content.projectTitle : PREP_BUILD ? PREP_ENTRY_COURSE : '任务信息'
  return (
    <div className="ws-taskinfo ts-taskinfo">
      <h2>{title}</h2>
      {PREP_BUILD && <p className="ts-synth-flag">
        <Icon name="shield-check" size={14} tone="neutral" />
        {PREP_ENTRY_NOTE}
      </p>}
      {init === null ? (
        <InitLoading />
      ) : init.kind === 'ready' ? (
        <ReadyTaskInfo init={init} />
      ) : (
        <InitUnavailable init={init} onReload={onReload} />
      )}
    </div>
  )
}

function ReadyTaskInfo({ init }: { init: ReadyInit }) {
  const { session, assignment, activity, materials, prepContext } = init
  const brief = activity.content.content
  return (
    <>
      <Section title={PREP_BUILD ? '身份与会话（合成）' : '身份与会话'}>
        <Fact label="模式" value={PREP_BUILD ? '准备场景（合成）' : '真实分配'} />
        <Fact label="Session userId" value={session.userId} />
        <Fact
          label="课程归属"
          value={session.courses.map((x) => `${x.courseId}（${x.role}）`).join('、') || '（空）'}
        />
        {PREP_BUILD && <Fact label="登录页面" value="未交付（U-07）：会话由 fixture 用合成账号建立，不自建登录页" />}
        {PREP_BUILD && prepContext && (
          <>
            <Fact label="场景 ID" value={prepContext.scenarioId} />
            <Fact label="preparation epoch" value={prepContext.preparationEpoch} />
            <Fact label="authority 活跃会话数" value={String(prepContext.authority.activeSessions)} />
          </>
        )}
      </Section>

      <Section title="分配（Assignment）">
        <Fact label="assignmentId" value={assignment.assignmentId} />
        <Fact label="activityVersionId" value={assignment.activityVersionId} />
        <Fact label="studentId" value={assignment.studentId} />
        <Fact label="状态" value={`${assignment.status} · active=${String(assignment.active)}`} />
        <Fact label="assignmentRevision" value={String(assignment.assignmentRevision)} />
        <Fact label="activityControlRevision" value={String(assignment.activityControlRevision)} />
        {(assignment.reasons.individual || assignment.reasons.activity) && (
          <Fact
            label="暂停原因"
            value={`individual=${assignment.reasons.individual || '(空)'} · activity=${assignment.reasons.activity || '(空)'}`}
          />
        )}
      </Section>

      <Section title="活动要求（student 视角）">
        <Fact label="项目" value={brief.projectTitle} />
        <Block label="问题" text={brief.problem} />
        <Block label="交付物" text={brief.artifact} />
        <Block label="面向学生" text={brief.audience} />
        <Block label="已有基础" text={brief.studentBackground} />
        <Block label="时间约束" text={brief.timeConstraints} />
        <Fact label="可选路线" value={brief.routes.join(' / ') || '(空)'} />
        <Fact label="帮助策略" value={`${activity.helpPolicy.versionId} · helpAllowed=${String(activity.helpPolicy.helpAllowed)} · 不给整份实现=${String(activity.helpPolicy.wholeSolutionAllowed === false)}`} />
        <Fact label="运行时 profile" value={activity.runtimeProfileVersionId} />
        <List title="能力目标（三条并列能力线）" items={brief.goals.map((g) => `${g.title} · ${domainLabel(g.domain)}${g.core ? ' · 核心' : ''}`)} />
        <List title="任务" items={brief.tasks.map((t) => t.title)} />
        <List title="里程碑" items={brief.milestones.map((m) => m.title)} />
        <List title="可观察表现" items={brief.observations.map((o) => o.description)} />
        <List title="评价标准" items={brief.rubricCriteria.map((r) => r.description)} />
      </Section>

      <Section title={`材料（${materials.length} 条，按活动投影顺序）`}>
        <MaterialList materials={materials} />
      </Section>
    </>
  )
}

function domainLabel(domain: 'domain' | 'project' | 'ai_collaboration'): string {
  if (domain === 'domain') return '学科知识与技能'
  if (domain === 'project') return '项目能力'
  return '人机协同与 AI 素养'
}

function MaterialList({ materials }: { materials: MaterialRead[] }) {
  return (
    <ul className="ts-materials">
      {materials.map((m) => (
        <li key={m.index} className={`ts-material ${m.state.kind}`}>
          <header>
            <b>#{m.index + 1}</b>
            <span className={`ts-material-status ${m.state.kind}`}>{materialStatusText(m)}</span>
          </header>
          {m.state.kind === 'loaded' && (
            <>
              <p className="ts-material-title">{m.state.view.title}</p>
              <pre className="ts-material-text">{m.state.view.text}</pre>
              {/* 材料版本 ID 与内容摘要留在 HTTP 响应里排障，不给学生看。 */}
              <p className="ts-material-meta">共 {m.state.view.paragraphs.length} 段</p>
            </>
          )}
          {m.state.kind === 'not-readable' && (
            <p className="ts-material-note">
              {m.state.reason === 'redacted'
                ? '服务端已裁剪：不返回 ID、标题或正文，客户端不补造内容。'
                : '固定版本与当前草稿不一致或缺失，服务端标为不可用。'}
            </p>
          )}
          {m.state.kind === 'failed' && (
            <p className="ts-material-note fail">这份材料没有读取成功，请重新读取。</p>
          )}
        </li>
      ))}
    </ul>
  )
}

function materialStatusText(m: MaterialRead): string {
  if (m.state.kind === 'loaded') return 'available'
  if (m.state.kind === 'not-readable') return m.state.reason
  return '读取失败'
}

/* ---------- 不可用状态 ---------- */

function InitLoading() {
  return (
    <p className="ts-loading" role="status">
      <Icon name="refresh" size={14} tone="neutral" />
      正在读取任务与材料…
    </p>
  )
}

export function InitUnavailable({ init, onReload }: { init: WorkspaceInit; onReload: () => void }) {
  if (init.kind === 'stale') return null
  if (init.kind !== 'unavailable') return null
  // 阶段码、失败体与不可用原因原文只进控制台：学生看到的是「为什么进不去 + 能做什么」。
  reportDiagnostic('workspace.initialize-failed', { stage: init.stage, reason: init.reason,
    technical: init.failure ? describeFailure(init.failure) : null })
  return (
    <div className="ts-unavailable" role="status">
      <p className="ts-unavailable-head">
        <Icon name="danger-triangle" size={16} tone="neutral" />
        现在还不能进入工作区
      </p>
      <p className="ts-unavailable-reason">{init.reason}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {!PREP_BUILD && init.stage === 'assignment' && <Link className="primary" to="/">
          <IconText name="arrow-left">返回我的任务</IconText>
        </Link>}
        <button type="button" className="outline" onClick={onReload}>
          <IconText name="refresh">重新读取</IconText>
        </button>
      </div>
    </div>
  )
}

/* ---------- 小构件 ---------- */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ts-section">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="ws-kv">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  )
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div className="ts-block">
      <span>{label}</span>
      <p>{text}</p>
    </div>
  )
}

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div className="ts-list">
      <span>{title}</span>
      <ul>
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  )
}
