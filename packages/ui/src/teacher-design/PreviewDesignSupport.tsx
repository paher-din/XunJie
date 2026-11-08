import { Icon, IconText } from '../icons'
import { DesignCheckGroup as CheckGroup } from './controls'
import type { DesignCheckDisplay, PreviewSection, PreviewSuggestionDisplay } from './types'
export interface PreviewDesignSupportProps {
 preview:boolean;assistantTab:'assistant'|'checks';setAssistantTab:(value:'assistant'|'checks')=>void
 blocks:DesignCheckDisplay[];questions:DesignCheckDisplay[];setSection:(section:PreviewSection)=>void
 prompt:string;setPrompt:(value:string)=>void;suggestion:PreviewSuggestionDisplay|null;conflicts:boolean;ready:boolean
 setModal:(value:'suggestion')=>void;showSuggestion:()=>void;openPreview:()=>void
}
export function PreviewDesignSupport({preview,assistantTab,setAssistantTab,blocks,questions,setSection,prompt,setPrompt,suggestion,conflicts,ready,setModal,showSuggestion,openPreview}:PreviewDesignSupportProps) { return (<aside className="td-rail" aria-label="设计支持">
        <div className="td-rail-tabs" role="tablist" aria-label="设计支持标签"><button type="button" id="td-assistant-tab" role="tab" aria-selected={assistantTab === 'assistant'} aria-controls="td-assistant-panel" onClick={() => setAssistantTab('assistant')} onKeyDown={event => { if (event.key === 'ArrowRight') { setAssistantTab('checks'); document.getElementById('td-checks-tab')?.focus() } }}><IconText name="assistant-mark" tone="neutral">设计助手</IconText></button><button type="button" id="td-checks-tab" role="tab" aria-selected={assistantTab === 'checks'} aria-controls="td-checks-panel" onClick={() => setAssistantTab('checks')} onKeyDown={event => { if (event.key === 'ArrowLeft') { setAssistantTab('assistant'); document.getElementById('td-assistant-tab')?.focus() } }}>设计检查<span>{blocks.length}</span></button></div>
        {assistantTab === 'assistant' ? <div id="td-assistant-panel" role="tabpanel" aria-labelledby="td-assistant-tab" className="td-assistant">
          <div className="td-assistant-intro"><span className="td-assistant-symbol"><Icon name="assistant-mark" size={28} tone="neutral" /></span><h3>和你一起，打磨好问题</h3><p>让目标、活动和评价之间，建立看得见的联系。</p><span className="td-example-tag">{preview ? '本机示例 · 未调用 AI' : '设计服务待接线'}</span></div>
          <div className="td-assistant-message"><p>先从你最关心的一点开始。你可以描述学生的基础、希望看到的表现，或项目中还不确定的部分。</p><p className="td-hint">当前提供固定示例建议；采用前会展示内容对比，不自动改写草稿。</p></div>
          <div className="td-prompt-shortcuts">{['驱动问题是否足够具体？', '怎样观察三条能力线？', '帮助政策如何写清楚？'].map(text => <button type="button" key={text} disabled={!preview} onClick={() => setPrompt(text)}>{text}<Icon name="arrow-up" tone="neutral" /></button>)}</div>
          {suggestion && <div className="td-suggestion-card"><span>示例建议</span><strong>{suggestion.title}</strong><p>{conflicts ? '你已更新相关字段。旧建议暂不可采用，避免覆盖新编辑。' : '建议已准备好，原稿保持不变。'}</p><button type="button" className="td-btn" onClick={() => setModal('suggestion')}>对比内容</button></div>}
          <div className="td-composer"><label className="td-sr-only" htmlFor="td-design-prompt">希望讨论的设计问题</label><textarea id="td-design-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} disabled={!preview} placeholder="描述你的教学想法或疑问…" rows={3} /><div><span>示例建议依据当前章节</span><button type="button" disabled={!preview} aria-label="查看示例建议" title="查看示例建议，不调用真实 AI" onClick={showSuggestion}><Icon name="arrow-up" tone="neutral" size={18} /></button></div></div>
        </div> : <div id="td-checks-panel" role="tabpanel" aria-labelledby="td-checks-tab" className="td-checks">
          <div className={`td-check-summary${ready ? ' is-ready' : ''}`}><Icon name={ready ? 'check-circle' : 'checklist'} size={28} tone="neutral" /><h3>{ready ? '结构已齐备，继续核对' : '让设计再完整一点'}</h3><p>本机结构检查随编辑更新，不代表教学质量或真实验收通过。</p></div>
          <CheckGroup title="阻断项" count={blocks.length} tone="block" empty="必填结构已补齐" items={blocks} onSelect={setSection} />
          <CheckGroup title="设计疑点" count={questions.length} tone="question" empty="目前未发现这些结构疑点" items={questions} onSelect={setSection} />
          <div className="td-check-group"><div className="td-check-group-title"><span className="td-check-dot pending" /><strong>待验证</strong><span>2</span></div><p>教师逐项试做，确认问题可完成、时长合理，评价依据足够。</p><p>真实保存、角色权限与分配接口接入后，完成服务端与浏览器验收。</p></div>
          <button type="button" className="td-btn td-check-preview" onClick={openPreview}>查看三个角色的预览<Icon name="arrow-right" tone="neutral" /></button>
        </div>}
        <div className="td-rail-footnote"><Icon name="lock-keyhole" tone="neutral" /><span>{preview ? '草稿与示例建议仅保存在本机预览' : '真实业务接线前，编辑与分配保持关闭'}</span></div>
      </aside>) }
