import { useEffect, useState } from 'react'
import type { ConfirmationWorkspace } from './confirmationWorkspace'
import { TutoringWorkspace, type TutoringState } from './tutoringWorkspace'
const idle: TutoringState = { ledger: null, busy: false, synchronized: false, notice: null }
export function useTutoringWorkspace(confirmation: ConfirmationWorkspace | null) {
  const context = confirmation?.context
  const [client, setClient] = useState<TutoringWorkspace | null>(null)
  const [state, setState] = useState(idle)
  useEffect(() => {
    setState(idle)
    if (!confirmation || !context?.attemptId) { setClient(null); return }
    const current = new TutoringWorkspace(confirmation, context)
    setClient(current)
    const unsubscribe = current.subscribe(setState)
    let started = false
    let lastControl: string | null=null
    const stopConfirmation = confirmation.subscribe(value=> {
      if(value.attempt) {
        const next=JSON.stringify([value.attempt.decisionEpoch,value.attempt.status,value.attempt.reminders])
        if(lastControl!==null && next!==lastControl) current.invalidateControl()
        lastControl=next
      }
      if (!started && value.attempt && ['ready','readonly'].includes(value.phase)) { started = true; void current.initialize() }
    })
    const timer = window.setInterval(() => { if (!current.current.busy) void current.read() }, 2500)
    const reconnect = () => { void current.read(true) }
    window.addEventListener('online', reconnect)
    return () => { clearInterval(timer); window.removeEventListener('online', reconnect); stopConfirmation(); unsubscribe(); current.dispose() }
  }, [confirmation, context])
  return { client, state }
}
