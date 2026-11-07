import {afterEach,describe,expect,it,vi} from 'vitest'
import {createMaterialCache,cacheableMaterial} from './materials'
import type {ActiveEnvironment,CachedResource,PreparationRecord,PreparationStore} from './store'
import {sha256} from './device'
import type {LearningActivity} from '@xunjie/contracts/learning-data'
import type {CourseActivityBinding} from '@xunjie/contracts/courses'
afterEach(()=>{vi.unstubAllGlobals()})
const bytes=(value:string)=>new TextEncoder().encode(value)
async function fixture(text='先核对观察，再讨论解释。'){
  const store=new Map<string,CachedResource>()
  const memory:PreparationStore={read:async()=>undefined,write:async()=>{},list:async()=>[],readCheck:async()=>undefined,writeCheck:async()=>{},
    readResource:async id=>store.get(id),writeResource:async r=>{store.set(r.sha256,r)},dropResource:async id=>{store.delete(id)},
    readEnvironment:async()=>undefined,activate:async(_r:PreparationRecord,_e:ActiveEnvironment)=>{}}
  const material={materialId:crypto.randomUUID(),title:'阅读材料',mediaType:'text/plain',sha256:await sha256(bytes(text)),byteLength:bytes(text).length}
  const course={releaseId:crypto.randomUUID(),materials:[material]} as unknown as CourseActivityBinding
  const activity={activityId:crypto.randomUUID(),identity:{environmentId:crypto.randomUUID(),spaceId:crypto.randomUUID(),
    principalId:crypto.randomUUID()},course} as unknown as LearningActivity
  const fetch=vi.fn(async()=>new Response(JSON.stringify({...material,contentBase64:Buffer.from(bytes(text)).toString('base64')})))
  vi.stubGlobal('fetch',fetch)
  return {store,memory,course,activity,material,fetch,text}
}
describe('fixed course text material cache',()=>{
  it('reads a declared material once, then serves the same verified bytes without the service',async()=>{
    const f=await fixture(),cache=createMaterialCache({store:f.memory})
    expect(await cache.text(f.activity,f.course,'school','ns',f.material)).toBe(f.text)
    expect(f.fetch).toHaveBeenCalledTimes(1)
    expect(await cache.text(f.activity,f.course,'school','ns',f.material)).toBe(f.text)
    expect(f.fetch).toHaveBeenCalledTimes(1)
    expect([...f.store.values()].every(r=>r.sha256===f.material.sha256)).toBe(true)
  })
  it('re-downloads instead of serving a corrupted or truncated cache entry',async()=>{
    const f=await fixture(),cache=createMaterialCache({store:f.memory})
    await cache.text(f.activity,f.course,'school','ns',f.material)
    const cached=f.store.get(f.material.sha256)!
    cached.bytes=cached.bytes.slice();cached.bytes[0]^=1
    expect(await cache.text(f.activity,f.course,'school','ns',f.material)).toBe(f.text)
    expect(f.fetch).toHaveBeenCalledTimes(2)
    expect(await cache.text(f.activity,f.course,'school','ns',f.material)).toBe(f.text)
    expect(f.fetch).toHaveBeenCalledTimes(2)
  })
  it('refuses an answer that describes a different material than the release declared',async()=>{
    const f=await fixture(),cache=createMaterialCache({store:f.memory})
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({...f.material,materialId:crypto.randomUUID(),
      contentBase64:Buffer.from(bytes('另一份材料')).toString('base64')}))))
    await expect(cache.text(f.activity,f.course,'school','ns',f.material)).rejects.toThrow()
    expect(f.store.size).toBe(0)
  })
  it('does not cache an answer whose bytes do not match the declared digest',async()=>{
    const f=await fixture(),cache=createMaterialCache({store:f.memory})
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({...f.material,
      contentBase64:Buffer.from(bytes('被替换的正文')).toString('base64')}))))
    await expect(cache.text(f.activity,f.course,'school','ns',f.material)).rejects.toThrow('material-corrupt')
    expect(f.store.size).toBe(0)
  })
  it('treats only student-visible text as locally readable',()=>{
    expect(cacheableMaterial('text/plain')).toBe(true)
    expect(cacheableMaterial('application/json')).toBe(true)
    expect(cacheableMaterial('application/pdf')).toBe(false)
    expect(cacheableMaterial('application/wasm')).toBe(false)
  })
})
