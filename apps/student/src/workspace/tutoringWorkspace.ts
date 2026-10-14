import { requiredId, record, revision } from './confirmation'
import type { ConfirmationWorkspace } from './confirmationWorkspace'
import type { CommandContext } from './frozenCommand'
import { apiGet, apiPostFrozen, WorkspaceRequestError } from './http'
import { type TutorJob, type TutorObject, type TutorReceiptKind, type TutorHistoryState } from './tutoringContracts'
import { verifyTutorContent, verifyTutorPage } from './tutoringEvents'
import { readTutorLedger, tutorChannel, tutorLedgerKey, writeTutorLedger, writeTutorHistoryCache, type TutorCommand, type TutorLedger, type TutorMessage } from './tutoringStore'
import { emptyTutorHistory, verifyTutorHistory, verifyTutorSource, sameTutorSource } from './tutoringHistory'
import { limitedCheckFromHead } from './tutoringControls'
import { verifyTutorCommandReceipt } from './tutoringCommand'
import { confirmationRepository } from './confirmationDb'
import { tutoringRequest } from './tutoringTransport'
import { describeError, reportDiagnostic } from './diagnostics'
import { tutoringCommandFailureNotice, tutoringFailureNotice, tutoringReadRejectionNotice } from './tutoringNotice'

export interface TutoringState { ledger: TutorLedger | null; busy: boolean; synchronized: boolean; notice: string | null; history?:TutorHistoryState; limitedCheck?:boolean|null; sendingKey?:string|null }
/** One owner serializes durable facts. Never create another global ContextGuard. */
export class TutoringWorkspace {
  private state: TutoringState = { ledger: null, busy: false, synchronized: false, notice: null, limitedCheck:null,
    history:{phase:'unavailable',data:emptyTutorHistory(),notice:null} }
  private readonly listeners = new Set<(s: TutoringState) => void>()
  private alive = true
  private sequence = 0
  private historySequence = 0
  private historyPending = false
  private closeChannel?: () => void
  private chain: Promise<void> = Promise.resolve()
  private displayFence = false
  private stopVersion = 0
  private requiresRevalidation = true
  private automaticReadsPaused = false
  private readonly observed = new Map<string, { actionId: string; hash: string; kind: TutorReceiptKind; command: TutorCommand }>()
  constructor(readonly confirmation: ConfirmationWorkspace, readonly context: CommandContext) {}
  get current() { return this.state }
  private valid = () => this.alive && this.confirmation.isCurrent(this.context)
  private opts() { return { mode: this.context.mode, scenarioId: this.context.scenarioId } }
  subscribe(fn: (s: TutoringState) => void) { this.listeners.add(fn); fn(this.state); return () => { this.listeners.delete(fn) } }
  dispose() { this.alive = false; this.sequence++; this.historySequence++
    this.state={...this.state,history:{phase:'unavailable',data:emptyTutorHistory(),notice:null}}
    this.closeChannel?.(); this.listeners.clear() }
  private protectLedger(ledger: TutorLedger) {
    ledger.stopVersion=this.stopVersion
    const latest=this.confirmation.current.attempt
    ledger.messages.forEach(m=>{if(!latest || m.epoch!==latest.decisionEpoch || !['ready','active'].includes(latest.status))m.valid=false})
    for(const fact of this.observed.values()) {
      const m=ledger.messages.find(m=>m.payload.actionId===fact.actionId && m.payload.contentHash===fact.hash)
      if(!m) continue
      m.facts[fact.kind] ??= structuredClone(fact.command)
      if(fact.kind==='displayed') m.shown=true
    }
    if(this.displayFence) { ledger.blocked=true;ledger.messages.forEach(m=>{if(!m.shown)m.valid=false}) }
    return ledger
  }
  private controlsCurrent(epoch: number) {
    const latest=this.confirmation.current.attempt
    return this.valid() && !!latest && latest.decisionEpoch===epoch && ['ready','active'].includes(latest.status)
  }
  invalidateControl() {
    this.sequence++
    this.requiresRevalidation=true
    const ledger=this.state.ledger?structuredClone(this.state.ledger):null
    ledger?.messages.forEach(m=>{m.valid=false})
    this.publish({ledger,synchronized:false})
  }
  private publish(change: Partial<TutoringState>) {
    if (!this.valid()) return
    if(change.ledger) this.protectLedger(change.ledger)
    if(this.displayFence && change.synchronized) change.synchronized=false
    if(change.synchronized && change.ledger?.control && !this.controlsCurrent(change.ledger.control.decisionEpoch)) change.synchronized=false
    this.state = { ...this.state, ...change }; this.listeners.forEach(fn => fn(this.state))
  }
  private enqueue(work: () => Promise<void>) {
    const next = this.chain.then(async () => { if (this.valid()) await work() })
    this.chain = next.catch(e => {
      reportDiagnostic('workspace.read-failed', { source: 'tutoring.operation', error: describeError(e) })
      this.publish({ notice: tutoringFailureNotice(e, '辅导操作未完成，请重新读取并核对原请求。编辑和保存仍可继续。'), busy: false })
    })
    return this.chain
  }
  private async persist(ledger: TutorLedger) {
    if (!await confirmationRepository.isCurrentAuthority(this.context) || !this.valid()) throw new Error('原辅导代际已退役，请重新载入')
    await writeTutorLedger(this.protectLedger(ledger), this.valid)
    if (this.valid()) this.publish({ ledger: structuredClone(ledger) })
  }
  async initialize() {
    try {
      if (!this.context.attemptId || !this.context.trustedRecoveryGeneration) return
      const channel = await tutorChannel(this.context)
      if (!this.valid()) { channel.close(); return }
      this.closeChannel = channel.close
      const key = tutorLedgerKey(this.context, channel.clientId), old = await readTutorLedger(key)
      if (!this.valid()) return
      const ledger: TutorLedger = old ?? { key, clientId: channel.clientId, cursor: 0, control: null, messages: [], commands: [], job: null, blocked: false }
      this.displayFence=ledger.blocked
      this.stopVersion=ledger.stopVersion??0
      // A cache is historical only until the original channel is revalidated from zero.
      ledger.messages.forEach(m => { m.valid = false })
      await this.persist(ledger)
      void this.readHistory()
      await this.read(true)
    } catch (e) {
      reportDiagnostic('workspace.read-failed', { source: 'tutoring.initialize', error: describeError(e) })
      this.publish({ notice: tutoringFailureNotice(e, '辅导本机存储不可用，请恢复本机存储后重新读取；当前作品仍可继续编辑和保存。') })
    }
  }
  read(revalidate = false) {
    return this.enqueue(async () => {
      if (this.automaticReadsPaused && !revalidate) return
      await this.readNow(revalidate)
    })
  }
  private clearHistory(notice:string) {
    this.historySequence++;this.historyPending=false
    this.publish({history:{phase:'unavailable',data:emptyTutorHistory(),notice}})
  }
  /** Authorizes a historical view on every HTTP read; never calls fact(), updates the cursor or releases a fence. */
  async readHistory() {
    if(!this.valid()||!this.context.attemptId)return
    const seq=++this.historySequence,isCurrent=()=>this.valid()&&seq===this.historySequence
    this.historyPending=true
    // Cached or previously authorized text does not survive this fresh authorization boundary.
    this.publish({history:{phase:'loading',data:emptyTutorHistory(),notice:null}})
    try {
      const raw=await tutoringRequest(apiGet<unknown>(`/attempts/${encodeURIComponent(this.context.attemptId)}/teaching-records`,this.opts()))
      if(!isCurrent())return
      const data=await verifyTutorHistory(raw,this.context)
      if(!isCurrent())return
      const authority=await confirmationRepository.isCurrentAuthority(this.context)
      if(!isCurrent())return
      if(!authority)throw new Error('原历史读取代际已退役，请重新载入')
      let notice:string|null=null
      try {await writeTutorHistoryCache(this.context,data,isCurrent)}
      catch(e){
        reportDiagnostic('workspace.read-failed', { source: 'tutoring.history-cache', error: describeError(e) })
        notice='已核对公开历史，本机副本未保存。下次查看时请重新读取。'
      }
      if(!isCurrent())return
      this.publish({history:{phase:'ready',data,notice}})
    } catch(e) {
      reportDiagnostic('workspace.read-failed', { source: 'tutoring.history', error: describeError(e) })
      if(isCurrent())this.publish({history:{phase:'unavailable',data:emptyTutorHistory(),
        notice:`教学历史不可回取：${tutoringFailureNotice(e, '请稍后重新读取；编辑和保存仍可继续。')}`}})
    } finally {if(seq===this.historySequence)this.historyPending=false}
  }
  private async readNow(revalidate: boolean) {
    const current = this.state.ledger
    if (!current) return
    this.publish({ busy: true, synchronized: false, notice: null })
    const seq = ++this.sequence
    let refreshHistory=false
    try {
      const head = await tutoringRequest(this.confirmation.readHead({controlsOnly:true}))
      if (!this.valid() || seq !== this.sequence) return
      if(!head) {
        this.publish({limitedCheck:null})
        // ConfirmationWorkspace catches failed HTTP reads and clears its Attempt instead of throwing.
        // A superseded read with a still-verified Attempt does not revoke a separately authorized history.
        if(!this.confirmation.current.attempt)this.clearHistory('当前工作区读取未获确认，教学历史需重新授权。')
        return
      }
      this.publish({limitedCheck:limitedCheckFromHead(head)})
      refreshHistory=true
      // Learn durable remote stop before allowing any previously retrieved candidate to render.
      if (this.state.ledger?.job) await this.readJobNow()
      if (!this.valid() || seq !== this.sequence) return
      let ledger = structuredClone(this.state.ledger!), epoch = head.attempt.decisionEpoch
      let cursor = revalidate || this.requiresRevalidation || ledger.control?.decisionEpoch !== epoch ? 0 : ledger.cursor
      if (cursor === 0) ledger.messages.forEach(m => { m.valid = false })
      let finished = false
      for (let pages = 0; pages < 30; pages++) {
        const query = new URLSearchParams({ afterServerSeq: String(cursor), limit: '100', clientId: ledger.clientId,
          recoveryGeneration: this.context.trustedRecoveryGeneration!, decisionEpoch: String(epoch) })
        const value = await tutoringRequest(apiGet<unknown>(`/attempts/${encodeURIComponent(this.context.attemptId!)}/events?${query}`, this.opts()))
        if (!this.valid() || seq !== this.sequence) return
        const page = verifyTutorPage(value, cursor)
        const latest=this.confirmation.current.attempt
        if(!latest || latest.decisionEpoch>page.control.decisionEpoch || latest.attemptRevision>page.control.attemptRevision ||
          (latest.status==='paused' && page.control.status!=='paused')) throw new Error('已读取新的控制状态，旧教学页不接纳')
        if (page.control.generation !== this.context.trustedRecoveryGeneration) throw new Error('服务代际已改变，请重新载入工作区')
        if (page.control.decisionEpoch < epoch) throw new Error('迟到的教学控制页，需重新读取')
        ledger.control = page.control
        if(page.coverage && page.coverage.attemptId!==this.context.attemptId) throw new Error('采集覆盖不属于当前尝试')
        ledger.coverage=page.coverage
        if (page.resyncRequired || page.control.decisionEpoch !== epoch) {
          epoch = page.control.decisionEpoch; cursor = 0; ledger.messages.forEach(m => { m.valid = false })
          await this.persist(ledger)
          continue
        }
        for (const event of page.events) {
          if (!event.payload) continue
          try {
            const p = await verifyTutorContent(event.payload)
            const source = verifyTutorSource(p, this.context, epoch)
            if (!this.valid() || seq !== this.sequence) return
            const old = ledger.messages.find(m => m.payload.actionId === p.actionId)
            if (old && (old.payload.contentHash !== p.contentHash || old.payload.content !== p.content)) { old.valid = false; throw new Error('同一教学动作的正文发生冲突') }
            if (old) {
              const previous=verifyTutorSource(old.payload,this.context,epoch)
              if(previous && (!source || !sameTutorSource(previous,source))) {old.valid=false;throw new Error('同一教学动作的原始来源发生冲突')}
              if(source)Object.assign(old.payload,source)
              old.valid = !ledger.blocked && ['ready','active'].includes(page.control.status); old.payload.basisRevised = p.basisRevised
            }
            else if (!ledger.blocked && ['ready', 'active'].includes(page.control.status)) {
              const message: TutorMessage = { payload: p, epoch, valid: true, shown: false, facts: {} }
              message.facts.received = this.receiptCommand(ledger, message, 'received')
              ledger.messages.push(message)
            }
          } catch (e) {
            // Retain the gap, advance only after persisting the page with that gap visible.
            reportDiagnostic('workspace.read-failed', { source: 'tutoring.content', error: describeError(e) })
            this.publish({ notice: tutoringFailureNotice(e, '内容不可用，请重新读取核对。已有历史记录保留，也可以继续自主操作。') })
          }
        }
        cursor = page.nextServerSeq; ledger.cursor = Math.max(ledger.cursor, cursor)
        await this.persist(ledger)
        if(!this.valid() || seq!==this.sequence) return
        if (!page.hasMore) { finished = true; break }
      }
      if (!finished) throw new Error('教学补取尚未完成，请继续核对')
      if(!this.valid() || seq!==this.sequence) return
      if(!this.controlsCurrent(epoch)) ledger.messages.forEach(m=>{if(!m.shown)m.valid=false})
      await this.persist(ledger)
      if(!this.valid() || seq!==this.sequence) return
      this.requiresRevalidation=false
      this.automaticReadsPaused=false
      this.publish({ synchronized: true })
      await this.flushReceipts()
    } catch (e) {
      reportDiagnostic('workspace.read-failed', { source: 'tutoring.events', error: describeError(e) })
      const rejected=this.valid()&&seq===this.sequence&&e instanceof WorkspaceRequestError&&
        e.failure.kind==='api'&&!e.failure.error.retryable
      if(rejected)this.automaticReadsPaused=true
      if(e instanceof WorkspaceRequestError&&e.failure.kind==='api'&&['UNAUTHENTICATED','FORBIDDEN','RECOVERY_REQUIRED'].includes(e.failure.error.code)) {
        refreshHistory=false
        this.publish({limitedCheck:null})
        this.clearHistory('当前授权或代际已失效，请重新载入。')
      }
      this.publish({ synchronized: false, notice: `辅导读取未完成：${rejected?tutoringReadRejectionNotice(e):
        tutoringFailureNotice(e, '请稍后重新读取；编辑和保存仍可继续。')}` })
    }
    finally { this.publish({ busy: false }); if(revalidate&&refreshHistory&&!this.historyPending)void this.readHistory() }
  }
  private receiptCommand(ledger: TutorLedger, message: TutorMessage, kind: TutorReceiptKind): TutorCommand {
    return { key: crypto.randomUUID(), kind: 'receipt', state: 'pending', path: `/actions/${encodeURIComponent(message.payload.actionId)}/receipts`,
      wireJson: JSON.stringify({ recoveryGeneration: this.context.trustedRecoveryGeneration, clientId: ledger.clientId,
        contentHash: message.payload.contentHash, receiptKind: kind, clientReceiptId: crypto.randomUUID(),
        deliveryId: message.payload.deliveryId, clientDeclaredAt: new Date().toISOString() }) }
  }
  fact(actionId: string, kind: 'displayed' | 'acknowledged') {
    // Capture the actual observation NOW; stop/control changes during the queue cannot erase it.
    const ledger=this.state.ledger?structuredClone(this.state.ledger):null
    const message=ledger?.messages.find(m=>m.payload.actionId===actionId)
    if(!ledger || !message || !this.valid() || message.facts[kind] ||
      (kind==='displayed' && (!this.state.synchronized || this.displayFence || !message.valid ||
        !this.controlsCurrent(message.epoch) || document.visibilityState!=='visible')) ||
      (kind==='acknowledged'&&!message.shown)) return Promise.resolve()
    const command=this.receiptCommand(ledger,message,kind)
    this.observed.set(`${actionId}:${message.payload.contentHash}:${kind}`,{actionId,hash:message.payload.contentHash,kind,command})
    message.facts[kind]=command
    if(kind==='displayed')message.shown=true
    this.publish({ledger})
    return this.enqueue(async () => {
      const ledger = structuredClone(this.state.ledger)
      if (!ledger) return
      await this.persist(ledger)
      await this.flushReceipts()
    })
  }
  private async flushReceipts() {
    const keys = this.state.ledger!.messages.flatMap(m => Object.values(m.facts).map(c=>c.key))
    for (const key of keys) {
      const ledger = structuredClone(this.state.ledger!)
      const m = ledger.messages.find(m=>Object.values(m.facts).some(c=>c.key===key))!
      const command = Object.values(m.facts).find(c=>c.key===key)!
      if (command.state !== 'pending') continue
      try {
        const raw = await tutoringRequest(apiPostFrozen<unknown>(command.path, command.wireJson, { ...this.opts(), idempotencyKey: command.key }))
        if (!this.valid()) return
        const ack = record(raw), input = JSON.parse(command.wireJson)
        requiredId(ack.receiptId); revision(ack.serverSeq, 1)
        if (ack.actionId !== m.payload.actionId || ack.receiptKind !== input.receiptKind || typeof ack.replayed !== 'boolean') throw new Error('教学回执归属不符')
        command.state = 'confirmed'; command.result = raw
      } catch (e) {
        if (!this.valid()) return
        command.error = e instanceof Error ? e.message : String(e)
        reportDiagnostic('command.failed', { source: 'tutoring.receipt', error: describeError(e) })
        if (e instanceof WorkspaceRequestError && e.failure.kind === 'api' && !e.failure.error.retryable) command.state = 'rejected'
        this.publish({ notice: '展示/回应事实已保存在本机，服务回执尚未确认；核对时保留原请求。' })
      }
      await this.persist(ledger)
    }
  }
  send(question: string, objectRef?: TutorObject, replace = false, objectCurrent: () => boolean = () => true) {
    // Capture intent before the queue or HTTP wait; a later stop must fence this older send.
    const issuedStopVersion=this.stopVersion, originalObject=objectRef?structuredClone(objectRef):undefined
    return this.enqueue(async () => {
    if(issuedStopVersion!==this.stopVersion) {this.publish({notice:'等待期间已停止帮助，原问题未发送。'});return}
    if (!question.trim() || !this.state.ledger) return
    if (this.state.ledger.commands.some(c => c.state === 'pending')) { this.publish({ notice: '先核对原求助或停止请求，再发送新问题。' }); return }
    if (this.state.ledger.job && !this.state.ledger.job.stopRequested && (!this.state.ledger.job.status || ['queued', 'running', 'cancelling', 'outcome_unknown'].includes(this.state.ledger.job.status)) && !replace) {
      this.publish({ notice: '当前帮助尚未结束；明确选择“替换并发送”才发新问题。' }); return
    }
    this.publish({ busy: true, notice: null })
    try {
      const head = await tutoringRequest(this.confirmation.readHead({controlsOnly:true}))
      if(!this.valid())return
      if(!head) {
        this.publish({limitedCheck:null})
        if(!this.confirmation.current.attempt)this.clearHistory('当前工作区读取未获确认，教学历史需重新授权。')
        throw new Error('当前尝试未读取，问题未发送')
      }
      this.publish({limitedCheck:limitedCheckFromHead(head)})
      if(issuedStopVersion!==this.stopVersion)throw new Error('等待期间已停止帮助，原问题未发送。')
      if(limitedCheckFromHead(head)!==false)throw new Error(head.limitedCheck===true?'限定检查进行中，当前不能发送辅导问题。':'限定检查状态尚未确认，请重新读取后再求助。')
      if (!objectCurrent()) throw new Error('所指代码或原对象已改变，问题未发送；请重新核对')
      if (!['ready', 'active'].includes(head.attempt.status)) throw new Error('当前尝试不允许新求助')
      if (originalObject && originalObject.attemptId !== this.context.attemptId) throw new Error('求助对象不属于当前尝试')
      const ledger = structuredClone(this.state.ledger!)
      const command: TutorCommand = { key: crypto.randomUUID(), kind: 'help', state: 'pending', question,
        issuedStopVersion,
        path: `/attempts/${encodeURIComponent(this.context.attemptId!)}/help`,
        wireJson: JSON.stringify({ question, expectedAttemptRevision: head.attempt.attemptRevision,
          recoveryGeneration: this.context.trustedRecoveryGeneration, ...(originalObject ? { objectRef:originalObject } : {}) }) }
      ledger.commands.push(command); await this.persist(ledger)
      if(!this.valid())return
      if(issuedStopVersion!==this.stopVersion) {
        command.state='rejected';command.error='等待期间已停止帮助，原问题未发送。'
        await this.persist(ledger);throw new Error(command.error)
      }
      await this.executeCommand(command.key)
    } catch (e) {
      reportDiagnostic('workspace.read-failed', { source: 'tutoring.help-preflight', error: describeError(e) })
      if(e instanceof WorkspaceRequestError&&e.failure.kind==='api'&&['UNAUTHENTICATED','FORBIDDEN','RECOVERY_REQUIRED'].includes(e.failure.error.code))
        this.clearHistory('当前授权或代际已失效，请重新载入。')
      this.publish({ notice: tutoringFailureNotice(e, '问题未完成发送。原问题保留，请重新读取并核对。') })
    }
    finally { this.publish({ busy: false }) }
  }) }
  retry() { return this.enqueue(async () => {
    const c = this.state.ledger?.commands.find(c => c.state === 'pending')
    if (c) { this.publish({ busy: true }); await this.executeCommand(c.key); this.publish({ busy: false }) }
    await this.readNow(true)
  }) }
  stop() {
    // Fence incoming pages synchronously, before the persistent cancel and before awaits.
    this.sequence++
    this.stopVersion++
    this.displayFence=true
    const stopped=this.state.ledger?structuredClone(this.state.ledger):null
    if(stopped) {stopped.blocked=true;stopped.messages.forEach(m=>{if(!m.shown)m.valid=false})}
    this.publish({ ledger:stopped, synchronized: false })
    return this.enqueue(async () => {
      const ledger = structuredClone(this.state.ledger)
      if (!ledger) return
      if(!ledger.job) {
        await this.persist(ledger)
        this.publish({notice:'已保留停止意图；原求助尚待核对，取得原 Job 后再确认取消。'})
        return
      }
      if(ledger.job.stopRequested) {await this.persist(ledger);return}
      ledger.blocked = true; ledger.messages.forEach(m => { if (!m.shown) m.valid = false })
      const command=this.cancelCommand(ledger.job.jobId)
      if (!ledger.commands.some(c => c.kind === 'cancel' && c.state === 'pending')) ledger.commands.push(command)
      await this.persist(ledger)
      this.publish({ busy: true, notice: '本页已暂停展示，正在核对服务端停止结果。' })
      await this.executeCommand(ledger.commands.find(c => c.kind === 'cancel' && c.state === 'pending')?.key ?? command.key)
      await this.readNow(true)
      this.publish({ busy: false })
    })
  }
  private cancelCommand(jobId:string):TutorCommand {
    return {key:crypto.randomUUID(),kind:'cancel',state:'pending',path:`/jobs/${encodeURIComponent(jobId)}/cancel`,
      wireJson:JSON.stringify({recoveryGeneration:this.context.trustedRecoveryGeneration,reason:'student_stop'})}
  }
  private async executeCommand(key: string) {
    if(!this.valid())return
    const ledger = structuredClone(this.state.ledger!), command = ledger.commands.find(c => c.key === key)!
    this.publish({sendingKey:key})
    try {
      const raw = await tutoringRequest(apiPostFrozen<unknown>(command.path, command.wireJson, { ...this.opts(), idempotencyKey: key }))
      if (!this.valid()) return
      const result = await verifyTutorCommandReceipt(this.context, command, raw)
      if (!this.valid()) return
      let inheritedStop:string|undefined
      if (command.kind === 'help') {
        const id = requiredId(result.jobId); revision(result.decisionEpoch); revision(result.attemptRevision)
        if (!Array.isArray(result.replacedJobIds) || typeof result.acceptedInputHash !== 'string') throw new Error('求助接纳结果不完整')
        ledger.job = { jobId: id } as TutorJob
        if((command.issuedStopVersion??0)===this.stopVersion) {this.displayFence=false;ledger.blocked=false}
        else {
          // A later explicit stop also covers this original help whose acceptance was unknown.
          // Cancel only after its original ACK identifies the Job, before reading any new delivery.
          const cancel=this.cancelCommand(id)
          const pending=ledger.commands.find(c=>c.kind==='cancel'&&c.path===cancel.path&&c.state==='pending')
          if(!pending)ledger.commands.push(cancel)
          inheritedStop=pending?.key??cancel.key
        }
        ledger.messages.forEach(m => { m.valid = false })
      } else {
        const originalJobId=decodeURIComponent(command.path.split('/')[2]!)
        if (result.jobId !== originalJobId || result.stopRequested !== true || !Array.isArray(result.invalidatedActionIds)) throw new Error('停止结果不完整')
        if(ledger.job?.jobId===originalJobId)ledger.job.stopRequested = true
        ledger.messages.forEach(m => { if ((result.invalidatedActionIds as unknown[]).includes(m.payload.actionId)) m.valid = false })
        this.publish({ notice: '服务端已保存停止请求；原生成与已展示历史保留。' })
      }
      command.state = 'confirmed'; command.result = raw; delete command.error; await this.persist(ledger)
      if(inheritedStop) {await this.executeCommand(inheritedStop);return}
      await this.readJobNow()
      await this.readNow(true)
    } catch (e) {
      if (!this.valid()) return
      reportDiagnostic(command.state==='confirmed' ? 'workspace.read-failed' : 'command.failed',
        { source: 'tutoring.command', kind: command.kind, state: command.state, error: describeError(e) })
      if (command.state==='confirmed') { this.publish({ notice: tutoringCommandFailureNotice(command, e) }); return }
      command.error = e instanceof Error ? e.message : String(e)
      if (e instanceof WorkspaceRequestError && e.failure.kind === 'api' && !e.failure.error.retryable) command.state = 'rejected'
      await this.persist(ledger)
      this.publish({ notice: tutoringCommandFailureNotice(command, e) })
    } finally {
      if(this.state.sendingKey===key)this.publish({sendingKey:null})
    }
  }
  private async readJobNow() {
    const ledger = structuredClone(this.state.ledger!), jobId = ledger.job?.jobId
    if (!jobId) return
    const value = record(await tutoringRequest(apiGet<unknown>(`/jobs/${encodeURIComponent(jobId)}`, this.opts())))
    if (!this.valid() || this.state.ledger?.job?.jobId !== jobId) return
    const scope = record(value.scope)
    if (value.jobId !== jobId || value.purpose !== 'student_help' || value.recoveryGeneration !== this.context.trustedRecoveryGeneration
      || scope.attemptId !== this.context.attemptId || scope.studentId !== this.context.userId || scope.courseId !== this.context.courseId
      || !['queued','running','succeeded','failed','cancelling','cancelled','stale','timed_out','outcome_unknown'].includes(String(value.status))
      || typeof value.stopRequested !== 'boolean' || !Number.isFinite(Date.parse(String(value.deadline)))) throw new Error('帮助Job归属或状态不完整')
    ledger.job = value as unknown as TutorJob
    if (value.stopRequested) { ledger.blocked = true; ledger.messages.forEach(m => { if (!m.shown) m.valid = false }) }
    await this.persist(ledger)
  }
}
