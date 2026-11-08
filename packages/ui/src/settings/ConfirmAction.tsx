import { useState } from 'react'

/** 二次确认的通用小组件：点「执行」→ 就地确认 → 执行并 toast。 */
export function ConfirmAction({
  label, icon, confirmText, onRun, danger,
}: {
  label: string
  icon: React.ReactNode
  confirmText: string
  onRun: () => void
  danger?: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  if (confirming) {
    return (
      <span className="st-cf-inline">
        {confirmText}
        <button className={danger ? 'st-cf-yes' : 'st-cf-yes primary-yes'} onClick={() => { setConfirming(false); onRun() }}>确认</button>
        <button className="st-cf-no" onClick={() => setConfirming(false)}>取消</button>
      </span>
    )
  }
  return (
    <button className={'outline st-xs' + (danger ? ' danger' : '')} onClick={() => setConfirming(true)}>
      {icon}{label}
    </button>
  )
}


import type { ComponentProps } from 'react'
export type ConfirmActionProps = ComponentProps<typeof ConfirmAction>
