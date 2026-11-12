import { useEffect, useRef } from 'react'

export function useViewPolling(read: () => Promise<unknown>, scope: string, interval: number, enabled = true, wake?: string) {
  const current = useRef({ read, interval })
  current.current = { read, interval }
  const running = useRef<{ scope: string; promise: Promise<unknown> } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      clearTimeout(timer)
      if (!live || document.hidden) return
      try {
        if (running.current?.scope === scope) await running.current.promise.catch(() => {})
        if (!live || document.hidden) return
        const pending = current.current.read()
        running.current = { scope, promise: pending }
        try { await pending } finally { if (running.current?.promise === pending) running.current = null }
      } catch {}
      finally { if (live && !document.hidden) timer = setTimeout(() => { void poll() }, current.current.interval) }
    }
    const resume = () => { if (!document.hidden && running.current?.scope !== scope) void poll() }
    void poll()
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      live = false; clearTimeout(timer)
      window.removeEventListener('focus', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [scope, enabled, wake, interval])
}
