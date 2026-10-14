/** A stalled connection is an unknown transport result, never a invented remote terminal state. */
export async function tutoringRequest<T>(request: Promise<T>, milliseconds=8000):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined
  try {
    return await Promise.race([request,new Promise<never>((_,reject)=> {
      timer=setTimeout(()=>reject(new Error('辅导连接等待已超限，结果未知；保留原请求后核对。')),milliseconds)
    })])
  } finally {clearTimeout(timer)}
}
