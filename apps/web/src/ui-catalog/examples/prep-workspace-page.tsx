import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  PrepBadge, PrepHelpMenu, PrepWorkspaceHeader, PrepWorkspaceCommandBar,
  PrepDraftConflictBar, PrepDraftConflictRow, PrepHdlBuildSettings, PrepHdlBuildPanel,
  PrepHdlRequestAction, PrepComparisonAction, PrepSessionReplaceDialog, PrepTutoringReturnNotice,
  type PrepBadgeProps, type PrepHelpMenuProps, type PrepDraftConflictChoice,
} from '@xunjie/ui/workspace'
import { Button } from '@xunjie/ui/foundation'
import type { CatalogEntry } from '../types'

const importPath = '@xunjie/ui/workspace'
const source = 'packages/ui/src/workspace/PrepWorkspacePageViews.tsx'
const exampleSource = 'apps/web/src/ui-catalog/examples/prep-workspace-page.tsx'
const snapshots = [{ id: 'example-snapshot-1', label: '确认作品 v1' }, { id: 'example-snapshot-2', label: '确认作品 v2' }]
const files = [{ fileId: 'example-local-c', path: 'src/main.c' }, { fileId: 'example-local-hdl', path: 'rtl/adder.v' }]
function Frame({ children }: { children: ReactNode }) {
  return <div className="demo-stack" style={{ width: '100%', padding: 24 }}>{children}</div>
}
function badgeProps(status: string, onSignOut: () => void, signingOut = false): PrepBadgeProps {
  const statusLabel = status === 'ready' ? '就绪' : status === 'loading' ? '读取中' : '不可用'
  return { status, loadEpoch: status === 'loading' ? 0 : 7, label: `目录示例 · ${statusLabel}`,
    modeLabel: '准备模式示例', statusLabel, attention: status !== 'ready', signingOut, onSignOut }
}
function BadgeDemo({ status = 'ready', ending = false }: { status?: string; ending?: boolean }) {
  const [signingOut, setSigningOut] = useState(ending)
  return <Frame><PrepBadge {...badgeProps(status, () => setSigningOut(true), signingOut)} />
    <output>{signingOut ? '示例结束状态：不会退出真实会话。' : '打开标识浮层，检查状态与退出入口。'}</output>
    {signingOut && <Button type="button" variant="outline" onClick={() => setSigningOut(false)}>重置本地状态</Button>}</Frame>
}
function HelpDemo({ boardOnly = false, empty = false }: { boardOnly?: boolean; empty?: boolean }) {
  const [snapshotId, setSnapshotId] = useState(empty ? '' : snapshots[0].id), [notice, setNotice] = useState('')
  const help: PrepHelpMenuProps = { onProjectHelp: () => setNotice('就项目求助'), boardHelp: { disabled: empty, onHelp: () => setNotice('引用当前板卡求助') },
    codeHelp: boardOnly ? undefined : { snapshotId, snapshots: empty ? [] : snapshots.map(option => ({ ...option, label: option.label.replace('确认作品', '求助快照') })),
      onSnapshotChange: setSnapshotId, onFileHelp: () => setNotice('就这个文件求助'), onSelectionHelp: () => setNotice('就所选代码求助') } }
  return <Frame><PrepHelpMenu {...help} /><output>{notice ? `本地回调：${notice}` : `示例所选快照：${snapshotId || '无'}`}</output></Frame>
}
function HeaderDemo({ restricted = false }: { restricted?: boolean }) {
  const [tabs, setTabs] = useState<HTMLDivElement | null>(null), [snapshotId, setSnapshotId] = useState(snapshots[0].id), [notice, setNotice] = useState('')
  return <Frame><div style={{ width: '100%' }}><PrepWorkspaceHeader tabsRef={setTabs} onBack={() => setNotice('返回回调，不改变路由')}
    badge={badgeProps(restricted ? 'unavailable' : 'ready', () => setNotice('退出回调，不退出真实会话'))}
    help={restricted ? undefined : { onProjectHelp: () => setNotice('项目求助'), boardHelp: { disabled: false, onHelp: () => setNotice('板卡求助') },
      codeHelp: { snapshotId, snapshots, onSnapshotChange: setSnapshotId, onFileHelp: () => setNotice('文件求助'), onSelectionHelp: () => setNotice('所选代码求助') } }}
    onSubmission={restricted ? undefined : () => setNotice('提交与反馈')}
    onStopHelp={restricted ? undefined : () => setNotice('停止帮助')} />
    {tabs && createPortal(<span>示例设计标签（Portal 挂点）</span>, tabs)}</div><output>{notice || '顶栏只触发本地回调。'}</output></Frame>
}
function CommandBarDemo() {
  const [run, setRun] = useState<HTMLDivElement | null>(null), [count, setCount] = useState(0)
  return <Frame><div style={{ width: '100%' }}><PrepWorkspaceCommandBar runRef={setRun} />
    {run && createPortal(<button type="button" className="ws-btn ghost" onClick={() => setCount(value => value + 1)}>示例运行簇操作</button>, run)}</div>
    <output>操作栏 Portal 回调 {count} 次；不运行代码。</output></Frame>
}
function ConflictDemo({ row = false, initiallyBusy = false }: { row?: boolean; initiallyBusy?: boolean }) {
  const [items, setItems] = useState(row ? files.slice(0, 1) : files), [busy, setBusy] = useState(initiallyBusy), [notice, setNotice] = useState('')
  const choose = (id: string, choice: PrepDraftConflictChoice) => { setNotice(`${id}：${choice === 'mine' ? '保留本页正文' : '载入另一处正文'}`); setItems(previous => previous.filter(file => file.fileId !== id)) }
  return <Frame>{row ? items.map(file => <PrepDraftConflictRow key={file.fileId} file={file} busy={busy} onChoose={choose} />) : <PrepDraftConflictBar files={items} busy={busy} onChoose={choose} />}
    <div className="demo-row"><Button type="button" variant="outline" onClick={() => setBusy(!busy)}>{busy ? '结束示例忙碌状态' : '设为忙碌'}</Button>
      <Button type="button" variant="outline" onClick={() => setItems(row ? files.slice(0, 1) : files)}>重置示例冲突</Button></div><output>{notice || '仅修改内存中的冲突列表，不处理真实草稿。'}</output></Frame>
}
function BuildSettingsDemo({ empty = false, pending = false }: { empty?: boolean; pending?: boolean }) {
  const [id, setId] = useState(empty ? '' : snapshots[0].id), [count, setCount] = useState(0)
  return <Frame><PrepHdlBuildSettings snapshotId={id} snapshots={empty ? [] : snapshots} onSelect={setId} busy={pending}
    showRead={!pending} readBusy={pending} onRead={() => setCount(value => value + 1)} />
    <output>示例快照：{id || '无'}；核对回调 {count} 次。</output></Frame>
}
const exampleBuild = {
  status: 'failed' as const, provenance: 'example-original-build',
  result: { buildId: 'example-build-1', snapshotId: 'example-snapshot-1', snapshotHash: 'example-hash',
    board: { boardProfileVersion: 'example-board', mappingVersion: 'example-mapping', topModule: 'example_top', bindings: [] },
    runtimeProfileVersion: 'example-runtime', engineVersion: 'example-engine', imageDigest: 'example-image', configurationHash: 'example-configuration',
    status: 'failed' as const, terminationConfirmed: true,
    diagnostics: [{ severity: 'error' as const, message: '目录示例：输入端口未连接', fileId: 'example-local-hdl', path: 'rtl/adder.v', line: 3, location: 'line-only' as const }],
    stdout: '目录内存示例日志', stderr: '示例构建未通过；没有运行真实编译器。' },
}
function BuildPanelDemo({ kind = 'failed' }: { kind?: 'failed' | 'running' | 'missing' }) {
  const [notice, setNotice] = useState('')
  const build = kind === 'missing' ? null : kind === 'running' ? { ...exampleBuild, status: 'running' as const, result: null } : exampleBuild
  return <Frame><div style={{ width: '100%' }}><PrepHdlBuildPanel build={build} busy={kind === 'running'} notice="目录示例：不是实际构建结果。" canHelp={kind === 'failed'}
    onRead={() => setNotice('读取回调')} onHelp={() => setNotice('引用构建求助回调')}
    onDiagnostic={(diagnostic, original) => setNotice(`源行 ${diagnostic.line} · 原构建 ${original.provenance}`)} /></div><output>{notice}</output></Frame>
}
function RequestDemo({ busy = false }: { busy?: boolean }) {
  const [count, setCount] = useState(0)
  return <Frame><PrepHdlRequestAction busy={busy} onReconcile={() => setCount(value => value + 1)} /><output>示例核对 {count} 次，不发送 HDL 请求。</output></Frame>
}
function ComparisonDemo() {
  const [count, setCount] = useState(0)
  return <Frame><PrepComparisonAction onCompare={() => setCount(value => value + 1)} /><output>示例比较入口回调 {count} 次。</output></Frame>
}
function ReplacementDemo({ blocked = false }: { blocked?: boolean }) {
  const [open, setOpen] = useState(true), [notice, setNotice] = useState('')
  const choose = (text: string) => { setNotice(text); setOpen(false) }
  return <Frame><Button type="button" variant="outline" onClick={() => setOpen(true)}>打开替换确认示例</Button><output>{notice}</output>
    {open && <PrepSessionReplaceDialog sessionId="example-session" sessionRevision={4} disabled={blocked}
      onKeep={() => choose('本地回调：保留原会话')} onReplace={() => choose('本地回调：确认替换；不执行实际装载')} />}</Frame>
}
function ReturnNoticeDemo({ kind = 'version' }: { kind?: 'version' | 'local' | 'missing' | 'toast' | 'hidden' }) {
  const [visible, setVisible] = useState(true)
  const origin = kind === 'version' || kind === 'local' ? { fileId: 'example-original-file', path: 'src/main.c', documentVersion: kind === 'local' ? null : 3 } : undefined
  return <Frame><Button type="button" variant="outline" onClick={() => setVisible(!visible)}>{visible ? '隐藏示例提示' : '显示示例提示'}</Button>
    <output>提示只陈述明确的内存示例引用，不定位文件。</output>
    {visible && <PrepTutoringReturnNotice toast={kind === 'toast' ? '目录示例：操作完成' : undefined}
      returnNotice={kind === 'toast' || kind === 'hidden' ? undefined : { notice: '目录示例：原精确位置未保留，请核对当前作品。', origin }} />}</Frame>
}

export const prepWorkspacePageEntries: CatalogEntry[] = [
  { id: 'prep-badge', name: 'PrepBadge', description: '模式、初始化事实和退出回调；数据为明确的目录示例。', importPath, source, exampleSource, props: ['status/loadEpoch/label/modeLabel/statusLabel/attention', 'signingOut/onSignOut'], dependencies: ['WorkspacePopover', 'IconText'], states: [
    { id: 'ready', name: '就绪', component: () => <BadgeDemo /> }, { id: 'loading', name: '读取中／零代次', component: () => <BadgeDemo status="loading" /> },
    { id: 'unavailable', name: '不可用', component: () => <BadgeDemo status="unavailable" /> }, { id: 'signing-out', name: '结束中／禁用退出', component: () => <BadgeDemo ending /> },
  ] },
  { id: 'prep-help-menu', name: 'PrepHelpMenu', description: '项目、板卡、确认快照、文件与选区求助入口。', importPath, source, exampleSource, props: ['onProjectHelp/boardHelp/codeHelp'], dependencies: ['WorkspacePopover'], states: [
    { id: 'all', name: '完整入口与快照选择', component: () => <HelpDemo /> }, { id: 'board', name: '仅项目与板卡', component: () => <HelpDemo boardOnly /> },
    { id: 'empty', name: '无确认快照／板卡禁用', component: () => <HelpDemo empty /> },
  ] },
  { id: 'prep-workspace-header', name: 'PrepWorkspaceHeader', description: '真实顶栏、Portal 标签挂点与受控功能入口。', importPath, source, exampleSource, props: ['onBack/tabsRef/help/onSubmission/onStopHelp/badge'], dependencies: ['PrepHelpMenu', 'PrepBadge'], states: [
    { id: 'available', name: '完整功能入口', component: () => <HeaderDemo />, viewport: 'wide' }, { id: 'restricted', name: '未授权功能省略', component: () => <HeaderDemo restricted />, viewport: 'wide' },
  ] },
  { id: 'prep-workspace-command-bar', name: 'PrepWorkspaceCommandBar', description: '保留原操作栏 Portal ref，按钮只改变内存计数。', importPath, source, exampleSource, props: ['runRef'], dependencies: ['React Portal'], states: [{ id: 'portal', name: '运行簇挂点与回调', component: CommandBarDemo }] },
  { id: 'prep-draft-conflict-bar', name: 'PrepDraftConflictBar', description: '多个原文件实例的本机草稿冲突与选择。', importPath, source, exampleSource, props: ['files/busy/onChoose(fileId, choice)'], dependencies: ['PrepDraftConflictRow'], states: [
    { id: 'choices', name: '逐文件选择／空列表', component: () => <ConflictDemo /> }, { id: 'busy', name: '忙碌禁用', component: () => <ConflictDemo initiallyBusy /> },
  ] },
  { id: 'prep-draft-conflict-row', name: 'PrepDraftConflictRow', description: '独立文件冲突行，保留 fileId 与两种选择。', importPath, source, exampleSource, props: ['file/busy/onChoose'], dependencies: [], states: [
    { id: 'choices', name: '保留本页／采用另一处', component: () => <ConflictDemo row /> }, { id: 'busy', name: '行操作禁用', component: () => <ConflictDemo row initiallyBusy /> },
  ] },
  { id: 'prep-hdl-build-settings', name: 'PrepHdlBuildSettings', description: '确认快照与状态核对，选项来自内存数据。', importPath, source, exampleSource, props: ['snapshotId/snapshots/onSelect/busy/showRead/readBusy/onRead'], dependencies: ['WorkspacePopover'], states: [
    { id: 'snapshots', name: '快照选择／核对', component: () => <BuildSettingsDemo /> }, { id: 'empty', name: '尚无快照', component: () => <BuildSettingsDemo empty /> },
    { id: 'pending', name: '在途／隐藏核对按钮', component: () => <BuildSettingsDemo pending /> },
  ] },
  { id: 'prep-hdl-build-panel', name: 'PrepHdlBuildPanel', description: '原高度限制内的完整 HDL 构建展示；诊断回调保留泛型原对象。', importPath, source, exampleSource, props: ['HdlBuildPaneProps<TBuild>', 'build/busy/notice/canHelp/onDiagnostic/onHelp/onRead'], dependencies: ['HdlBuildPane'], states: [
    { id: 'failed', name: '诊断／原对象回调／日志', component: () => <BuildPanelDemo /> }, { id: 'running', name: '尚无真实结果', component: () => <BuildPanelDemo kind="running" /> },
    { id: 'missing', name: '没有构建', component: () => <BuildPanelDemo kind="missing" /> },
  ] },
  { id: 'prep-hdl-request-action', name: 'PrepHdlRequestAction', description: '原请求核对入口，不发送实际请求。', importPath, source, exampleSource, props: ['busy/onReconcile'], dependencies: [], states: [
    { id: 'available', name: '核对回调', component: () => <RequestDemo /> }, { id: 'busy', name: '忙碌禁用', component: () => <RequestDemo busy /> },
  ] },
  { id: 'prep-comparison-action', name: 'PrepComparisonAction', description: '比较双方正文的独立入口。', importPath, source, exampleSource, props: ['onCompare'], dependencies: [], states: [{ id: 'interactive', name: '比较回调', component: ComparisonDemo }] },
  { id: 'prep-session-replace-dialog', name: 'PrepSessionReplaceDialog', description: '显示明确的原会话与修订，不创建或替换真实会话。', importPath, source, exampleSource, props: ['sessionId/sessionRevision/disabled/onKeep/onReplace'], dependencies: [], states: [
    { id: 'confirm', name: '保留／确认替换', component: () => <ReplacementDemo />, height: 650 }, { id: 'blocked', name: '禁止替换', component: () => <ReplacementDemo blocked />, height: 650 },
  ] },
  { id: 'prep-tutoring-return-notice', name: 'PrepTutoringReturnNotice', description: '原引用提示与普通 toast，不恢复或定位作品。', importPath, source, exampleSource, props: ['toast/returnNotice.notice/returnNotice.origin'], dependencies: [], states: [
    { id: 'version', name: '原确认文件版本', component: () => <ReturnNoticeDemo /> }, { id: 'local', name: '本机未确认实例', component: () => <ReturnNoticeDemo kind="local" /> },
    { id: 'missing', name: '无原引用', component: () => <ReturnNoticeDemo kind="missing" /> }, { id: 'toast', name: '仅操作提示', component: () => <ReturnNoticeDemo kind="toast" /> },
    { id: 'hidden', name: '无提示内容', component: () => <ReturnNoticeDemo kind="hidden" /> },
  ] },
]
