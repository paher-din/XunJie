import { describe, expect, it } from 'vitest'
import { textHash } from './confirmation'
import { verifyTutorContent, verifyTutorPage } from './tutoringEvents'
const control = { attemptRevision: 1, decisionEpoch: 2, captureRevision: 0, collecting: true, reminders: false, generation: 'g1', status: 'active' }
describe('C3 public tutoring boundaries',()=> {
  it('allows gaps in serverSeq, rejects regression and duplicate event identities',()=> {
    const event = { serverSeq: 10, eventId: 'e1', type: 'teaching.delivery', occurredAt: new Date().toISOString() }
    const page = { control, resyncRequired: false, events: [event], nextServerSeq: 10, hasMore: false }
    expect(verifyTutorPage(page, 3)).toEqual(page)
    expect(()=>verifyTutorPage(page,11)).toThrow()
    expect(()=>verifyTutorPage({ ...page, events: [event,{...event,serverSeq:11}],nextServerSeq:11 },0)).toThrow()
    expect(()=>verifyTutorPage({...page,events:[],nextServerSeq:3,hasMore:true},3)).toThrow()
  })
  it('requires complete hash-verified content and never treats Job completion as display',async ()=> {
    const content = '\uFEFF原文\r\n😀', p = { actionId:'a1',deliveryId:'d1',content,contentHash:await textHash(content),
      disposition:'pending',createdAt:new Date().toISOString(),basisRevised:false,actionType:'hint',expectedStudentAction:'学生继续' }
    expect(await verifyTutorContent(p)).toEqual(p)
    await expect(verifyTutorContent({...p,content:content.trim()})).rejects.toThrow()
    await expect(verifyTutorContent({...p,content:undefined})).rejects.toThrow()
    await expect(verifyTutorContent({...p,actionType:'execute_html'})).rejects.toThrow()
    await expect(verifyTutorContent({...p,disposition:'stale'})).rejects.toThrow()
    await expect(verifyTutorContent({...p,deliveryId:undefined})).rejects.toThrow()
  })
})
