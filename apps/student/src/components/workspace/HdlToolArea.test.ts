import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CenterToolArea } from './CenterToolArea'
import { HdlBoardPane, HdlBuildPane, HdlRunCluster, HdlTracePane, hdlBit, hdlInputChange, hdlLight, hdlResultNotice, hdlSegmentLight, hdlSessionLabel, hdlTracePositions } from './HdlToolArea'
import type { HdlBuildView, HdlFrame, HdlInputs, HdlOperationResult, HdlSessionView } from '../../workspace/hdlContracts'

const inputs: HdlInputs = { switches: '0000000000000000', buttons: '00000', resetN: '1' }
const identity = { id: 'identity', commandId: 'command', requestHash: 'a'.repeat(64), recoveryGeneration: 'g1',
  scope: { courseId: 'course', studentId: 'student', attemptId: 'attempt', activityVersionId: 'activity' } }
const frame: HdlFrame = { ...inputs, simTimePs: '900719925474099312345', leds: 'x10000000000000z',
  anodes: '11111100', segments: 'x0z1010', dp: 'z' }
const session: HdlSessionView = { sessionId: 'session', identity, buildId: 'build', snapshotId: 'snapshot', snapshotHash: 'a'.repeat(64),
  boardProfileVersion: 'nexys4-ddr-rev-c-v1', mappingVersion: 'mapping', engineVersion: 'engine', runtimeProfileVersion: 'profile',
  sessionRevision: 2, confirmedSequence: 1, simTimePs: frame.simTimePs, status: 'active', terminationConfirmed: false,
  stopRequested: false, createdAt: '2026-10-14T00:00:00Z', deadline: '2026-10-14T01:00:00Z', lastOperationAt: '2026-10-14T00:00:00Z' }
const result: HdlOperationResult = { operationId: 'operation', sessionId: session.sessionId, buildId: session.buildId,
  snapshotId: session.snapshotId, snapshotHash: session.snapshotHash, boardProfileVersion: session.boardProfileVersion,
  mappingVersion: session.mappingVersion, engineVersion: session.engineVersion, sequence: 1, sessionRevision: 2,
  frames: [frame], finalFrame: frame, sampleCount: 33, droppedFrames: 32, coverage: 'incomplete', resultHash: 'b'.repeat(64) }

describe('HDL real four-state board', () => {
  it('uses the MSB-first bit index and preserves X/Z or missing data', () => {
    expect(hdlBit(frame.leds, 15, 16)).toBe('x')
    expect(hdlBit(frame.leds, 14, 16)).toBe('1')
    expect(hdlBit(frame.leds, 0, 16)).toBe('z')
    expect(hdlBit(undefined, 0, 16)).toBeNull()
    expect(hdlBit('0', 0, 16)).toBeNull()
    expect(hdlLight('1', 'high')).toBe('on')
    expect(hdlLight('0', 'low')).toBe('on')
    expect(hdlLight('x', 'low')).toBe('x')
    expect(hdlLight('z', 'high')).toBe('z')
  })

  it('consumes actual low-active segment and anode bits without repairing the digit', () => {
    expect(hdlSegmentLight('0', '0')).toBe('on')
    expect(hdlSegmentLight('0', '1')).toBe('off')
    expect(hdlSegmentLight('0', 'x')).toBe('x')
    expect(hdlSegmentLight('0', 'z')).toBe('z')
    expect(hdlSegmentLight('x', '0')).toBe('x')
    expect(hdlSegmentLight('1', '0')).toBe('off')
    const html = renderToStaticMarkup(createElement(HdlBoardPane, { session, result, inputs, pending: false, disabled: false, onInteract: vi.fn() }))
    expect(html).toContain('多位同时有效')
    expect(html).toContain('SEG(gfedcba)=x0z1010')
    expect(html).toContain('LED15: x（未知）')
    expect(html).toContain('LED0: z（高阻）')
    expect(html).toContain('data-segment="g" data-signal="x" data-display="x"')
    expect(html).toContain('data-segment="a" data-signal="0" data-display="on"')
    expect(html).toContain(frame.simTimePs)
    expect(html.match(/aria-label="拨码开关 SW\d+"/g)).toHaveLength(16)
    expect(html.match(/aria-label="按下 BTN\d"/g)).toHaveLength(5)
    expect(html.match(/aria-label="松开 BTN\d"/g)).toHaveLength(5)
  })

  it('explicit input changes have the original widths and independent press/release polarity', () => {
    const pressed = hdlInputChange(inputs, 'buttons', 4, '1')
    expect(pressed).toEqual({ ...inputs, buttons: '10000' })
    expect(hdlInputChange(pressed, 'buttons', 4, '0')).toEqual(inputs)
    expect(hdlInputChange(inputs, 'switches', 0, '1').switches).toBe('0000000000000001')
    expect(hdlInputChange(inputs, 'switches', 15, '1').switches).toBe('1000000000000000')
    expect(hdlInputChange(inputs, 'resetN', 0, '0').resetN).toBe('0')
    expect(() => hdlInputChange({ ...inputs, switches: '' }, 'switches', 0, '1')).toThrow()
    expect(inputs.buttons).toBe('00000')
  })

  it('pending disables every input action, including release, while retaining last confirmed output', () => {
    const html = renderToStaticMarkup(createElement(HdlBoardPane, { session: { ...session, pendingOperationId: 'next' }, result,
      inputs: { ...inputs, buttons: '11111', resetN: '0' }, pending: true, disabled: false, onInteract: vi.fn() }))
    const buttons = html.match(/<button\b[^>]*>/g) ?? []
    expect(buttons).toHaveLength(29)
    expect(buttons.every(button => button.includes('disabled=""'))).toBe(true)
    expect(html).toContain('等待当前操作确认')
    expect(html).toContain('操作序号 1')
    expect(html).toContain(frame.simTimePs)
    expect(html).toContain('LED0: z（高阻）')
  })

  it('does not display unreceived outputs as zeroes, or stop requested as confirmed exit', () => {
    const empty = renderToStaticMarkup(createElement(HdlBoardPane, { session: null, result: null, inputs, pending: true, disabled: true, onInteract: vi.fn() }))
    expect(empty).toContain('尚无已确认信号')
    expect(empty).toContain('LED15: 未取得')
    expect(hdlSessionLabel({ ...session, stopRequested: true })).toBe('等待确认退出')
    expect(hdlSessionLabel({ ...session, status: 'stopped' })).toBe('停止尚未确认')
    expect(hdlSessionLabel({ ...session, status: 'stopped', terminationConfirmed: true })).toBe('已确认停止')
    const stopped = renderToStaticMarkup(createElement(HdlBoardPane, { session: { ...session, status: 'stopped', terminationConfirmed: true }, result,
      inputs, pending: false, disabled: true, onInteract: vi.fn() }))
    expect(stopped).toContain('已确认停止')
    expect(stopped).toContain(frame.simTimePs)
  })

  it('guards raw Session pending/stopped state and labels results from a different session or sequence', () => {
    const html = renderToStaticMarkup(createElement(HdlBoardPane, { session: { ...session, pendingOperationId: 'next' }, result,
      inputs, pending: false, disabled: false, onInteract: vi.fn() }))
    expect((html.match(/<button\b[^>]*>/g) ?? []).every(button => button.includes('disabled=""'))).toBe(true)
    expect(hdlResultNotice({ ...session, sessionId: 'replacement' }, result)).toContain('先前会话')
    expect(hdlResultNotice({ ...session, confirmedSequence: 2 }, result)).toContain('序号 1 的旧采样')
    expect(hdlResultNotice(session, result)).toBeNull()
  })
})

describe('real finite trace and HDL layout', () => {
  it('scales geometry using exact integer deltas beyond Number precision and preserves labels', () => {
    const frames = [frame, { ...frame, simTimePs: (BigInt(frame.simTimePs) + 1n).toString() }, { ...frame, simTimePs: (BigInt(frame.simTimePs) + 4n).toString() }]
    expect(hdlTracePositions(frames)).toEqual([0, 240, 960])
    const html = renderToStaticMarkup(createElement(HdlTracePane, { session, result: { ...result, frames }, pending: true }))
    expect(html).toContain(frames[1].simTimePs)
    expect(html).toContain('incomplete（不完整）')
    expect(html).toContain('丢帧 32')
    expect(html).toContain('采样数 33')
    expect(html).toContain('以下保留上次确认窗口')
    expect(html).toContain('data-signal="x"')
    expect(html).toContain('data-signal="z"')
  })

  it('limits rendering to a declared view window without claiming source frames were dropped', () => {
    const frames = Array.from({ length: 33 }, (_, index) => ({ ...frame, simTimePs: String(index * 10000) }))
    const html = renderToStaticMarkup(createElement(HdlTracePane, { session, result: { ...result, frames, sampleCount: 33, droppedFrames: 0, coverage: 'complete' }, pending: false }))
    expect(html).toContain('显示第 1～16 帧 / 33')
    expect(html).toContain('丢帧 0')
    expect(html.match(/<tbody><tr>|<\/tr><tr>/g)).toHaveLength(16)
    expect(html).toContain('下一采样窗口')
    expect(html).not.toContain('全扫描通过')
  })

  it('the real variant never falls back to local simulated board, wave, editor or success controls', () => {
    const html = renderToStaticMarkup(createElement(CenterToolArea, { taskId: 'real-task', tool: 'board', variant: 'digital-logic-real', onToolChange: vi.fn(), onToast: vi.fn() }))
    expect(html).toContain('尚未取得真实 HDL 板卡结果')
    expect(html).not.toContain('板卡行为由界面脚本模拟')
    expect(html).not.toContain('静态演示代码')
    expect(html).not.toContain('计数')
    const injected = renderToStaticMarkup(createElement(CenterToolArea, { taskId: 'real-task', tool: 'board', variant: 'digital-logic-real', boardBody: createElement('p', null, 'confirmed-real-board'), onToolChange: vi.fn(), onToast: vi.fn() }))
    expect(injected).toContain('confirmed-real-board')
    const demo = renderToStaticMarkup(createElement(CenterToolArea, { taskId: 'demo-task', tool: 'board', onToolChange: vi.fn(), onToast: vi.fn() }))
    expect(demo).toContain('板卡行为由界面脚本模拟')
  })

  it('missing Build result cannot be presented as successful build, and Stop capability is independent', () => {
    const build = { result: null, status: 'succeeded', jobId: 'job' } as HdlBuildView
    const html = renderToStaticMarkup(createElement(HdlBuildPane, { build, onRead: vi.fn() }))
    expect(html).toContain('构建结果待读取')
    expect(html).not.toContain('构建成功')
    const run = renderToStaticMarkup(createElement(HdlRunCluster, { build, session, busy: true, canBuild: false, canLoad: false, canStop: true,
      onBuild: vi.fn(), onLoad: vi.fn(), onStop: vi.fn(), onRefresh: vi.fn() }))
    expect(run.match(/<button\b[^>]*>/g)?.[2]).not.toContain('disabled')
  })
})
