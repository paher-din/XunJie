import {afterEach,describe,expect,it,vi} from 'vitest'
import {aluPackage} from '../../../../components/alu-experiment/package.mjs'
import {createRuntimePreparation} from './runtime'
import type {PreparationStore,PreparationRecord,CachedResource,ActiveEnvironment} from './store'
import type {PreparationTarget} from './preparation'
import {sha256} from './device'
const originalNavigator=globalThis.navigator
afterEach(()=>{vi.unstubAllGlobals()})
async function fixture() {
  const input=await aluPackage(),resources=new Map<string,CachedResource>(),records=new Map<string,PreparationRecord>(),environments=new Map<string,ActiveEnvironment>()
  const store:PreparationStore={read:async id=>structuredClone(records.get(id)),write:async r=>{records.set(r.preparationId,structuredClone(r))},list:async key=>[...records.values()].filter(r=>r.scopeKey===key).map(r=>structuredClone(r)),
    readCheck:async()=>undefined,writeCheck:async()=>{},readResource:async id=>resources.get(id),writeResource:async r=>{resources.set(r.sha256,r)},dropResource:async id=>{resources.delete(id)},
    readEnvironment:async key=>environments.get(key),activate:async(r,e)=>{records.set(r.preparationId,structuredClone(r));environments.set(e.scopeKey,e)}}
  vi.stubGlobal('navigator',{...originalNavigator,platform:'Win32',userAgent:'Chrome/156',locks:{request:async (_:string,run:()=>Promise<unknown>)=>run()}})
  vi.stubGlobal('Worker',class {})
  vi.stubGlobal('indexedDB',{})
  const target:PreparationTarget={namespace:'test',spaceKey:'school',binding:{key:'alu',definition:{manifest:input.manifest,digest:await sha256(new TextEncoder().encode(JSON.stringify(input.manifest)))},configuration:{title:'ALU 实验'},materialIds:[]},
    activity:{activityId:crypto.randomUUID(),identity:{environmentId:crypto.randomUUID(),spaceId:crypto.randomUUID(),principalId:crypto.randomUUID()},course:{releaseId:crypto.randomUUID()}} as PreparationTarget['activity']}
  const fetch=vi.fn(async (url:string)=>{
    if(url.endsWith('/preparation-report'))return new Response('{}')
    const manifest=input.manifest
    if(manifest.formatVersion!==3)throw new Error('fixture')
    const ref=manifest.runtime.resources.find(r=>url.endsWith('/resources/'+r.path))
    const payload=ref?{...ref,contentBase64:input.runtimeResources!.find(r=>r.resourceId===ref.resourceId)!.contentBase64}:{definition:target.binding.definition,contentBase64:input.contentBase64}
    // Wire content carries no role from the host's manifest wrapper.
    return new Response(JSON.stringify(payload))
  })
  vi.stubGlobal('fetch',fetch)
  const check=vi.fn(async()=>{})
  return {store,resources,records,target,fetch,check}
}
describe('fixed runtime preparation',()=>{
  it.each(['adapter','version','operation','memory'] as const)('refuses an unsupported %s before downloading or self-checking',async kind=>{
    const f=await fixture(),m=f.target.binding.definition.manifest
    if(m.formatVersion!==3)throw new Error('fixture')
    if(kind==='adapter')m.runtime.adapterId='unknown-runtime'
    if(kind==='version')m.runtime.adapterVersion++
    if(kind==='operation')m.runtime.operations[0].operationId='unknown-operation'
    if(kind==='memory')m.runtime.operations[0].budgets.memoryMiB=16
    const result=await createRuntimePreparation({store:f.store,check:f.check}).prepare(f.target,crypto.randomUUID())
    expect(result.reason).toBe('protocol-unsupported');expect(result.status).not.toBe('ready')
    expect(f.check).not.toHaveBeenCalled();expect(f.fetch).not.toHaveBeenCalled()
  })
  it('reuses confirmed checks, but repairs and rechecks corrupted binary cache under the original preparation identity',async()=>{
    const f=await fixture(),prepare=createRuntimePreparation({store:f.store,check:f.check})
    const first=await prepare.prepare(f.target,crypto.randomUUID())
    expect(first.status).toBe('ready');expect(f.check).toHaveBeenCalledTimes(1)
    const second=await prepare.prepare(f.target,crypto.randomUUID())
    expect(second.preparationId).toBe(first.preparationId);expect(second.cacheHit).toBe(true);expect(f.check).toHaveBeenCalledTimes(1)
    const entry=[...f.resources.values()].find(r=>r.mediaType==='application/wasm')!
    entry.bytes=entry.bytes.slice();entry.bytes[0]^=1
    const repaired=await prepare.prepare(f.target,crypto.randomUUID())
    expect(repaired.status).toBe('ready');expect(repaired.preparationId).toBe(first.preparationId);expect(f.check).toHaveBeenCalledTimes(2)
  })
  it('never activates or invokes a toolchain when bytes cannot be reliably cached',async()=>{
    const f=await fixture();f.store.writeResource=async()=>{throw new Error('QuotaExceededError')}
    const prepare=createRuntimePreparation({store:f.store,check:f.check}),result=await prepare.prepare(f.target,crypto.randomUUID())
    expect(result.status).toBe('repairable');expect(result.reason).toBe('storage-unavailable');expect(f.check).not.toHaveBeenCalled()
    await expect(prepare.resources(f.target)).rejects.toThrow('capability-unavailable')
  })
  it('does not activate a runtime whose self-check exceeds the remaining overall preparation budget',async()=>{
    const f=await fixture(),manifest=f.target.binding.definition.manifest
    if(manifest.formatVersion!==3)throw new Error('fixture')
    const prepare=createRuntimePreparation({store:f.store,check:f.check})
    expect((await prepare.prepare(f.target,crypto.randomUUID())).status).toBe('ready')
    manifest.version=2;manifest.selfTest.selfTestVersion=2;manifest.environment.selfTestVersion=2
    manifest.budget.preparationTimeoutMs=1000
    f.target.binding.definition.digest=await sha256(new TextEncoder().encode(JSON.stringify(manifest)))
    f.check.mockImplementation(()=>new Promise<void>(()=>{}))
    const result=await prepare.prepare(f.target,crypto.randomUUID())
    expect(result.status).toBe('repairable');expect(result.reason).toBe('self-test-interrupted')
    await expect(prepare.resources(f.target)).rejects.toThrow('capability-unavailable')
  })
  it('makes verified local resources usable while the original preparation-report acknowledgement is stalled',async()=>{
    const f=await fixture(),normal=f.fetch.getMockImplementation()!
    f.fetch.mockImplementation(async url=>url.endsWith('/preparation-report')?new Promise<Response>(()=>{}):normal(url))
    const prepare=createRuntimePreparation({store:f.store,check:f.check})
    const ready=await prepare.prepare(f.target,crypto.randomUUID())
    expect(ready.status).toBe('ready')
    expect(Object.keys(await prepare.resources(f.target))).toContain('ivl.wasm')
    const report=(await f.store.read(ready.preparationId))!
    expect(report.reportSubmitted).toBe(false)
    const resumed=await prepare.prepare(f.target,crypto.randomUUID())
    expect(resumed.preparationId).toBe(ready.preparationId)
    expect((await f.store.read(ready.preparationId))!.reportRequestId).toBe(report.reportRequestId)
  })
})
