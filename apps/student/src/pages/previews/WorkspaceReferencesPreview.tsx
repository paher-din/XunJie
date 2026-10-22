import { useRef, useState } from 'react'
import { CodeReferenceSource, SelectionToolbar, TextReferenceSource, WorkspaceReferenceComposer,
  WorkspaceReferencesProvider, type ReferenceSubmission } from '../../components/workspace/references'
import './workspaceReferencesPreview.css'

const SAMPLE_TEXT = '样例材料：组合逻辑与时序逻辑\r\n先观察输入，再解释输出。中文、emoji 🧩 与符号 <>& 都应原样保留。\r\n请比较两种逻辑对时钟的依赖。'
const SAMPLE_CODE = '\uFEFF// 样例代码：中文 🧩\r\nmodule demo;\r\n  wire ready = 1\'b1;\r\nendmodule\r\n'

function WorkspaceDemo({ workspaceKey }: { workspaceKey: string }) {
  const [text, setText] = useState(SAMPLE_TEXT)
  const [code, setCode] = useState(SAMPLE_CODE)
  const [sourceVersion, setSourceVersion] = useState(1)
  const [fileVersion, setFileVersion] = useState(1)
  const [visible, setVisible] = useState(true)
  const [mode, setMode] = useState('accept')
  const [receipt, setReceipt] = useState<ReferenceSubmission | null>(null)
  const [waiting, setWaiting] = useState(false)
  const held = useRef<{ resolve(): void; reject(error: Error): void } | null>(null)
  const receive = async (submission: ReferenceSubmission) => {
    // Receipts are produced exclusively by this actual explicit-submit callback.
    if (mode === 'reject') throw new Error('示例接收器拒绝了本次提交，请调整后重试。')
    if (mode === 'hold') {
      setWaiting(true)
      try { await new Promise<void>((resolve, reject) => { held.current = { resolve, reject } }) }
      finally { setWaiting(false); held.current = null }
    }
    setReceipt(submission)
  }
  return <WorkspaceReferencesProvider workspaceKey={workspaceKey} onSubmit={receive}>
    <div className="wr-preview-grid">
      <section className="wr-preview-materials" aria-label="样例来源">
        <article className="wr-preview-card">
          <header><h2>课程材料 · 普通文本</h2><span>明确标识的样例</span></header>
          <div className="wr-preview-actions">
            <button type="button" onClick={() => setText(value => `${value}\r\n原文已更新：先预测，再验证。`)}>修改材料原文</button>
            <button type="button" onClick={() => setSourceVersion(value => value + 1)}>替换同名来源</button>
            <button type="button" onClick={() => setVisible(value => !value)}>{visible ? '卸载材料来源' : '恢复材料来源'}</button>
          </div>
          {visible ? <TextReferenceSource sourceId={`material-instance-${sourceVersion}`} sourceName="组合逻辑学习材料"
            text={text} /> : <p>来源已卸载，已添加的引用副本仍然保留。</p>}
        </article>
        <article className="wr-preview-card">
          <header><h2>作品 · 真实 Monaco 编辑器</h2><span>demo.sv · 样例</span></header>
          <p className="wr-hint">可直接编辑。初始内容包含 BOM、CRLF、中文与 emoji。</p>
          <div className="wr-preview-actions"><button type="button" onClick={() => setFileVersion(value => value + 1)}>替换同名代码文件</button></div>
          <CodeReferenceSource fileId={`demo-file-instance-${fileVersion}`} sourceName="demo.sv" language="systemverilog"
            initialText={code} readOnly={false} readOnlyReason={null} onTextChange={(_, next) => setCode(next)} onCursorChange={() => {}} />
        </article>
        <article className="wr-preview-card" aria-label="来源外部区域">
          <h2>来源边界检查</h2>
          <p>这段文字未登记为来源，选中它不会添加引用。</p>
          <label>普通输入<input aria-label="未登记输入" defaultValue="输入控件内容不会被引用" /></label>
          <label>密码输入<input aria-label="未登记密码" type="password" defaultValue="sample-only" /></label>
        </article>
      </section>
      <aside className="wr-preview-side">
        <WorkspaceReferenceComposer />
        <section className="wr-preview-card wr-preview-receiver" aria-label="示例接收器">
          <h2>示例接收器</h2>
          <p>只接收明确发送的问题与引用副本，不产生 AI 回答。</p>
          <label>接收方式<select aria-label="接收方式" value={mode} onChange={event => setMode(event.target.value)}>
            <option value="accept">立即接受</option><option value="reject">拒绝并保留草稿</option><option value="hold">等待手动确认</option>
          </select></label>
          {waiting && <div className="wr-preview-actions"><button type="button" onClick={() => held.current?.resolve()}>接受待处理提交</button>
            <button type="button" onClick={() => held.current?.reject(new Error('示例接收器拒绝了待处理提交。'))}>拒绝待处理提交</button></div>}
          {receipt ? <div role="status"><h3>已交给示例接收器</h3><pre data-testid="reference-receipt">{JSON.stringify(receipt, null, 2)}</pre></div>
            : <p>尚未收到提交。</p>}
        </section>
      </aside>
    </div>
    <SelectionToolbar />
  </WorkspaceReferencesProvider>
}
export default function WorkspaceReferencesPreview() {
  const [workspace, setWorkspace] = useState('sample-workspace-a')
  return <main className="wr-preview">
    <header className="wr-preview-top"><div><p>开发验收 · 前端组件</p><h1>选区引用组件验收</h1>
      <p>关闭对话后选择并点击“询问 Agent”；打开时新选择直接加入引用。Alt + Enter 可打开选区入口。</p></div>
      <label>工作区身份<select aria-label="工作区身份" value={workspace} onChange={event => setWorkspace(event.target.value)}>
        <option value="sample-workspace-a">样例工作区 A</option><option value="sample-workspace-b">样例工作区 B</option>
      </select></label>
    </header>
    <WorkspaceDemo key={workspace} workspaceKey={workspace} />
  </main>
}
