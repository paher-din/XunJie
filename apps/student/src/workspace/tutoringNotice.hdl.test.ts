import { expect, it } from 'vitest'
import { tutoringCommandFailureNotice, tutoringFailureNotice } from './tutoringNotice'
it.each(['所选 HDL 来源已变化或尚未核对，问题未发送','所选 HDL 来源在发送前改变，原问题未发送。'])('shows the deliberate static HDL guard: %s',message=> {
  expect(tutoringFailureNotice(new Error(message),'unavailable')).toBe(message)
  expect(tutoringCommandFailureNotice({kind:'help',state:'rejected',error:message})).toBe(message)
})
it('does not render unvalidated HDL protocol text, fields, paths or private payloads',()=> {
  expect(tutoringFailureNotice(new Error('PRIVATE_HDL_SOURCE_DO_NOT_RENDER'),'辅导不可用')).toBe('辅导不可用')
  expect(tutoringCommandFailureNotice({kind:'help',state:'pending',error:'PRIVATE_HDL_SOURCE_DO_NOT_RENDER'})).not.toContain('PRIVATE_HDL_SOURCE')
})
