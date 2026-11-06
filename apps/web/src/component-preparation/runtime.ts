import { componentBundleSchema, componentRuntimeResourceContentSchema, componentPreparationReportSchema,
  type ComponentRuntimeManifest, type PreparationReasonCode } from '@xunjie/contracts/components'
import { learningRequest } from '../product/learningTransport'
import { decodeBase64, detectDevice, fingerprint, hostVersion, missingFeatures, sha256 } from './device'
import { preparationStore, withPreparationLock, type PreparationRecord, type PreparationStore } from './store'
import type { PreparationTarget, PreparationSnapshot } from './preparation'
import { selfCheckIcarus,icarusProfile,icarusManifest } from '../tool-execution/icarus-runtime'

function manifestOf(target: PreparationTarget): ComponentRuntimeManifest {
  const manifest=target.binding.definition.manifest
  if(manifest.formatVersion!==3) throw new Error('unsupported-version')
  return manifest
}
export function runtimeScope(target: PreparationTarget) {
  const m=manifestOf(target)
  return JSON.stringify([target.namespace,target.activity.identity,m.componentId,m.version,target.binding.definition.digest,target.binding.configuration])
}
const snapshot=(r:PreparationRecord):PreparationSnapshot=>({...r, verification:r.status==='ready'?'verified':'unverified'})
async function withinDeadline<T>(task:Promise<T>, deadline:number):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined
  try { return await Promise.race([task,new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>reject(new Error('preparation-timeout')),Math.max(0,deadline-Date.now()))
  })]) } finally {clearTimeout(timer)}
}
const route=(target:PreparationTarget,suffix='')=>`releases/${target.activity.course!.releaseId}/components/${target.binding.key}${suffix}`
export function createRuntimePreparation(options: {store?:PreparationStore; check?:typeof selfCheckIcarus}={}) {
  const store=options.store??preparationStore, check=options.check??selfCheckIcarus
  async function bytes(target:PreparationTarget) {
    const m=manifestOf(target), result:Record<string,Uint8Array>={}
    for(const ref of m.runtime.resources) {
      const saved=await store.readResource(ref.sha256)
      if(!saved || saved.bytes.length!==ref.byteLength || await sha256(saved.bytes)!==ref.sha256) throw new Error('resource-corrupt')
      result[ref.path]=saved.bytes
    }
    return result
  }
  async function prepare(target:PreparationTarget, requestId:string) {
    return withPreparationLock(runtimeScope(target),async()=>{
      const m=manifestOf(target), scopeKey=runtimeScope(target), device=detectDevice(), deviceFingerprint=await fingerprint(device)
      const requestDigest=await fingerprint({scopeKey,deviceFingerprint,environment:m.environment,selfTest:m.selfTest})
      const saved=(await store.list(scopeKey)).find(r=>r.requestDigest===requestDigest)
      const wasReady=saved?.status==='ready'
      const now=new Date().toISOString()
      const record:PreparationRecord=saved??{preparationId:crypto.randomUUID(),scopeKey,requestId,requestDigest,componentId:m.componentId,
        version:m.version,definitionDigest:target.binding.definition.digest,configurationDigest:await fingerprint(target.binding.configuration),
        selfTestVersion:m.selfTest.selfTestVersion,stage:'identity',status:'preparing',reason:'none',device,deviceFingerprint,
        environmentId:null,checks:[],capabilities:[],cachedDependencies:[],cacheHit:false,resourceBytes:0,durationMs:0,
        reportId:null,reportRequestId:null,reportSubmitted:false,diagnostics:[],createdAt:now,updatedAt:now}
      const start=Date.now()
      const deadline=start+m.budget.preparationTimeoutMs
      const commit=async()=>{record.updatedAt=new Date().toISOString();await store.write(structuredClone(record))}
      await commit()
      try {
        record.stage='detect'; await commit()
        if(m.runtime.adapterId!==icarusProfile.adapterId || m.runtime.adapterVersion!==icarusProfile.adapterVersion
          || m.runtime.bundleIdentity!==icarusManifest.identity || m.runtime.operations.some(operation=>operation.operationId!==icarusProfile.operationId
            || operation.budgets.memoryMiB!==icarusProfile.memoryMiB))throw new Error('unsupported-version')
        if(missingFeatures(device,m.environment.requiredFeatures).length) throw new Error('device-feature-missing')
        record.stage='fetch';record.status='preparing';await commit()
        let cacheHit=true, resourceBytes=0
        const refs=[{...m.entry,path:'$entry'},...m.runtime.resources]
        for(const ref of refs) {
          if(Date.now()-start>m.budget.preparationTimeoutMs) throw new Error('preparation-timeout')
          let cached=await store.readResource(ref.sha256)
          if(!cached || cached.bytes.length!==ref.byteLength || await sha256(cached.bytes)!==ref.sha256) {
            cacheHit=false
            const response=await withinDeadline(learningRequest(target.activity,target.spaceKey,target.namespace,
              route(target,ref.path==='$entry'?'':`/resources/${ref.path}`)),deadline)
            const payload=ref.path==='$entry'?componentBundleSchema.parse(response):componentRuntimeResourceContentSchema.parse(response)
            if('definition' in payload && payload.definition.digest!==target.binding.definition.digest) throw new Error('resource-corrupt')
            if('path' in payload && (payload.path!==ref.path || payload.resourceId!==ref.resourceId || payload.sha256!==ref.sha256
              || payload.byteLength!==ref.byteLength || payload.mediaType!==ref.mediaType))throw new Error('resource-corrupt')
            const content=decodeBase64(payload.contentBase64)
            if(content.length!==ref.byteLength || await sha256(content)!==ref.sha256) throw new Error('resource-corrupt')
            cached={sha256:ref.sha256,byteLength:content.length,bytes:content,mediaType:ref.mediaType,storedAt:now}
            await store.writeResource(cached)
          }
          resourceBytes+=cached.bytes.length
        }
        record.cacheHit=cacheHit;record.resourceBytes=resourceBytes
        if(!wasReady || !cacheHit) {
          record.stage='self-test';await commit()
          const remaining=deadline-Date.now()
          if(remaining<=0)throw new Error('preparation-timeout')
          await withinDeadline(check(m.runtime.bundleIdentity,await bytes(target),m.selfTest.fixture,
            Math.min(m.selfTest.timeoutMs,remaining)),deadline)
        }
        if(Date.now()>deadline)throw new Error('preparation-timeout')
        record.status='ready';record.reason='none';record.stage='activate';record.environmentId=record.environmentId??crypto.randomUUID()
        record.durationMs=Date.now()-start
        record.capabilities=m.requiredCapabilities.map(capability=>({capability,availability:'available',reason:'none',verification:'verified'}))
        await store.activate(record,{scopeKey,environmentId:record.environmentId,preparationId:record.preparationId,componentId:m.componentId,
          version:m.version,definitionDigest:target.binding.definition.digest,activatedAt:new Date().toISOString()})
        const report=componentPreparationReportSchema.parse({formatVersion:1,componentId:m.componentId,version:m.version,
          definitionDigest:target.binding.definition.digest,preparationProtocolVersion:2,selfTestVersion:m.selfTest.selfTestVersion,hostVersion,device,
          status:record.status,reason:record.reason,stage:record.stage,capabilities:record.capabilities,durationMs:record.durationMs,
          resourceBytes,cacheHit,preview:target.activity.purpose==='preview'})
        // Keep an unacknowledged immutable submission; a new observation never changes its bytes.
        if(!record.reportPayload || record.reportSubmitted) {
          record.reportPayload=report;record.reportId=crypto.randomUUID();record.reportRequestId=crypto.randomUUID();record.reportSubmitted=false
        }
        await commit()
        const submission={reportId:record.reportId,requestId:record.reportRequestId,report:record.reportPayload}
        // Reporting is independent of activation. A stalled service must not delay a verified local run.
        void learningRequest(target.activity,target.spaceKey,target.namespace,route(target,'/preparation-report'),submission)
          .then(()=>withPreparationLock(scopeKey,async()=>{
            const current=await store.read(record.preparationId)
            if(current?.reportRequestId===submission.requestId)await store.write({...current,reportSubmitted:true})
          })).catch(()=>{ /* The original immutable report remains pending. */ })
      } catch(error) {
        const message=error instanceof Error?error.message:String(error)
        const reason:PreparationReasonCode=message==='preparation-timeout'?'self-test-interrupted':message==='resource-corrupt'?'resource-corrupt':message==='unsupported-version'?'protocol-unsupported':
          message==='device-feature-missing'?'device-feature-missing':/quota|storage/i.test(message)?'storage-unavailable':
          record.stage==='self-test'?'self-test-failed':'resource-missing'
        record.status='repairable';record.reason=reason;record.durationMs=Date.now()-start
        record.diagnostics=[...record.diagnostics,{at:now,stage:record.stage,reason,detail:message}].slice(-20)
        await commit()
      }
      return snapshot(record)
    })
  }
  async function resources(target:PreparationTarget) {
    const active=await store.readEnvironment(runtimeScope(target))
    if(!active || active.definitionDigest!==target.binding.definition.digest) throw new Error('capability-unavailable')
    const record=await store.read(active.preparationId)
    if(!record || record.status!=='ready' || record.deviceFingerprint!==await fingerprint(detectDevice())) throw new Error('capability-unavailable')
    return bytes(target)
  }
  async function entry(target:PreparationTarget) {
    const ref=manifestOf(target).entry, saved=await store.readResource(ref.sha256)
    if(!saved || await sha256(saved.bytes)!==ref.sha256) throw new Error('resource-corrupt')
    return new TextDecoder('utf-8',{fatal:true}).decode(saved.bytes)
  }
  return {prepare,resources,entry}
}
export const runtimePreparation=createRuntimePreparation()
