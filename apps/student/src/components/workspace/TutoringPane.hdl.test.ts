import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { TutoringPane } from './TutoringPane'
import type { TutoringWorkspace } from '../../workspace/tutoringWorkspace'
import type { TutorMessage, TutorLedger } from '../../workspace/tutoringStore'

it('renders the original HDL selection and frozen provenance with explicit receipt stages, without emitting acknowledgements',()=> {
  const fact=vi.fn(),message:TutorMessage={epoch:1,valid:false,shown:true,hdlInvalidated:true,facts:{received:{kind:'receipt',state:'confirmed',key:'received',path:'/actions/action/receipts',wireJson:'{}'}},
    payload:{actionId:'action',deliveryId:'delivery',contentHash:'a'.repeat(64),disposition:'pending',createdAt:'2026-10-14T00:00:00Z',basisRevised:false,
      content:'检查原诊断中的赋值右侧表达式。',actionType:'hint',expectedStudentAction:'自行修订',jobId:'original-job',messageId:'original-message',generation:'generation',
      scope:{courseId:'course',studentId:'student',attemptId:'attempt'},targetVersions:{activityVersionId:'activity',policyVersionId:'policy',modelConfigVersion:'model',promptVersion:'prompt',schemaVersion:'schema'},
      basis:{attemptRevision:1,decisionEpoch:1,captureRevision:0,relatedStateRevision:0,hdl:{snapshotId:'original-snapshot',snapshotHash:'b'.repeat(64),
        buildId:'original-build',buildStatus:'succeeded',workspaceRevision:4,buildResultHash:'c'.repeat(64),sessionId:'original-session',sessionRevision:2,
        confirmedSequence:1,simTimePs:'90071992547409930000',operationId:'original-operation',resultHash:'d'.repeat(64)}}}}
  const ledger:TutorLedger={key:'ledger',clientId:'client',cursor:3,control:null,messages:[message],commands:[],job:null,blocked:false}
  const client={context:{mode:'real'},confirmation:{current:{attempt:{status:'active'}},isCurrent:()=>true},fact,
    hdlSourceStatus:()=> '原 HDL 来源已变化或尚未核对，仅保留历史内容。'} as unknown as TutoringWorkspace
  const html=renderToStaticMarkup(createElement(TutoringPane,{open:true,onClose:()=>{},client,state:{ledger,busy:false,synchronized:true,notice:null,limitedCheck:false},
    helpAllowed:true,assignmentActive:true,hdlSelection:{snapshotId:'selected-snapshot',buildId:'selected-build'}}))
  expect(html).toContain('selected-snapshot');expect(html).toContain('original-snapshot');expect(html).toContain('original-build')
  expect(html).toContain('original-session');expect(html).toContain('90071992547409930000')
  expect(html).toContain('仅保留历史内容');expect(html).toContain('未发生');expect(html).toContain('未回应')
  expect(fact).not.toHaveBeenCalled()
})
