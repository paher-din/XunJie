import { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelDirectory, ModelDirectoryInput } from '@xunjie/contracts/model-connections'

export type ReadModelDirectory = (input: ModelDirectoryInput) => Promise<ModelDirectory>

/** Cached reads are local; only ensure/refresh can initiate an upstream request. */
export function useModelDirectory(read: ReadModelDirectory | undefined, input: ModelDirectoryInput, enabled = true) {
  const credentialIdentity = useRef({ value: '', revision: 0 })
  const value = input.credential?.action === 'replace' ? input.credential.value : input.credential?.action ?? ''
  if (credentialIdentity.current.value !== value) credentialIdentity.current = { value, revision: credentialIdentity.current.revision + 1 }
  // Keep credentials out of cache keys and status text.
  const key = JSON.stringify([input.presetId, input.variantId, input.baseUrl, input.protocol,
    input.savedCredential, credentialIdentity.current.revision])
  const current = useRef({ input, key, read, enabled }); current.current = { input, key, read, enabled }
  const generation = useRef(0), active = useRef(true)
  const running = useRef<{ key: string; epoch: number; promise: Promise<void> } | null>(null)
  const [snapshot, setSnapshot] = useState<{ key: string; data: ModelDirectory }>()
  const [busy, setBusy] = useState(false), [visibleBusy, setVisibleBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++ } }, [])
  useEffect(() => {
    if (!busy) { setVisibleBusy(false); return }
    const timer = setTimeout(() => setVisibleBusy(true), 150)
    return () => clearTimeout(timer)
  }, [busy])
  const update = useCallback(async (manual = false) => {
    const request = current.current
    if (!request.read || !request.enabled) return
    if (running.current?.key === request.key && running.current.epoch === generation.current) return running.current.promise
    const epoch = generation.current
    let finished = false, polling = false
    const live = () => active.current && generation.current === epoch && current.current.key === request.key
    const apply = (data: ModelDirectory) => { if (live()) { setSnapshot({ key: request.key, data }); setError('') } }
    setBusy(true)
    // A fast supplier response becomes visible even if the shared public download is slower.
    const timer = setInterval(() => {
      if (finished || polling || !live()) return
      polling = true
      void request.read!({ ...request.input, refresh: false }).then(data => {
        if (!finished) apply(data)
      }).catch(() => {}).finally(() => { polling = false })
    }, 750)
    const promise = request.read({ ...request.input, refresh: true, manual }).then(apply).catch(failure => {
      if (live()) {
        const code = failure instanceof Error && 'code' in failure ? failure.code : undefined
        setError(code === 'forbidden' ? '当前空间无法读取模型资料，请重新连接该空间后重试。当前填写已保留。'
          : code === 'maintenance' ? '模型资料服务正在维护，请稍后重试。当前列表和填写已保留。'
          : code === 'unavailable' ? '模型资料服务暂时不可用，请稍后重试。当前列表和填写已保留。'
          : '暂时无法更新模型资料，当前列表和填写已保留。请稍后重试。')
      }
    }).finally(() => {
      finished = true; clearInterval(timer)
      if (running.current?.promise === promise) running.current = null
      if (live()) setBusy(false)
    })
    running.current = { key: request.key, epoch, promise }
    return promise
  }, [])
  useEffect(() => {
    generation.current++; setError(''); setBusy(false)
    const request = current.current, epoch = generation.current
    if (!request.read || !enabled) return
    let cancelled = false
    const live = () => !cancelled && active.current && generation.current === epoch
    void request.read({ ...request.input, refresh: false }).then(data => {
      if (live()) setSnapshot({ key: request.key, data })
    }).catch(() => {}).finally(() => { if (live()) void update() })
    return () => { cancelled = true }
  }, [key, read, enabled, update])
  return { data: snapshot?.key === key ? snapshot.data : undefined, busy, visibleBusy, error,
    ensureFresh: update, refresh: () => update(true) }
}
