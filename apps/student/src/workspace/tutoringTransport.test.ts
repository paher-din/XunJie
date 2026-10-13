import { expect, it, vi } from 'vitest'
import { tutoringRequest } from './tutoringTransport'
it('a stalled request releases the wait as unknown and ignores a late ACK without inventing a terminal state',async()=> {
  vi.useFakeTimers()
  try {
    let resolve!:(value:string)=>void
    const late=new Promise<string>(r=>{resolve=r})
    const waiting=tutoringRequest(late,100)
    const assertion=expect(waiting).rejects.toThrow('结果未知')
    await vi.advanceTimersByTimeAsync(100);await assertion
    resolve('late service receipt')
    await expect(late).resolves.toBe('late service receipt')
    expect(vi.getTimerCount()).toBe(0)
  } finally {vi.useRealTimers()}
})
