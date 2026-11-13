import { useCallback, useId, useLayoutEffect, useState } from 'react'
import { Tooltip } from '@base-ui/react/tooltip'
import { Button } from '../foundation/Button'
import { Icon } from '../icons'
import './model-test-button.css'

export interface ModelTestButtonProps {
  kind: 'connection' | 'model'
  running?: boolean | undefined
  restart?: boolean | undefined
  disabled?: boolean | undefined
  compact?: boolean | undefined
  iconOnly?: boolean | undefined
  onTest(): void
  onStop?: (() => void) | undefined
}

/** Keep the same control and focus when a test becomes stoppable. */
export function ModelTestButton({ kind, running = false, restart = false, disabled = false, compact = false, iconOnly = false, onTest, onStop }: ModelTestButtonProps) {
  const tooltipId = useId()
  const [open, setOpen] = useState(false)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const locateContainer = useCallback((element: HTMLElement | null) => {
    if (element) setContainer(element.closest<HTMLElement>('[role="dialog"]'))
  }, [])
  useLayoutEffect(() => {
    if (!open) return
    // Close the tooltip before Radix Dialog handles the same Escape key.
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); setOpen(false)
    }
    window.addEventListener('keydown', close, true)
    return () => window.removeEventListener('keydown', close, true)
  }, [open])
  const label = restart ? '重新测试' : kind === 'connection' ? '连接测试' : '模型测试'
  const stoppable = running && Boolean(onStop)
  const accessibleLabel = stoppable ? `停止${kind === 'connection' ? '连接测试' : '模型测试'}` : running ? `${label}进行中`
    : restart ? `重新测试${kind === 'connection' ? '连接' : '模型'}` : label
  const tip = stoppable ? '停止测试' : restart ? '重新测试' : kind === 'connection' ? '测试连接' : '测试模型'
  return <Tooltip.Root open={open} onOpenChange={setOpen}>
    <Tooltip.Trigger ref={locateContainer} delay={300} render={<Button type="button" variant="outline" className={'st-model-test-button' + (compact ? ' st-xs' : '') + (iconOnly ? ' st-model-test-icon' : '')}
    data-running={running || undefined} aria-busy={running}
    aria-label={accessibleLabel} aria-describedby={open ? tooltipId : undefined}
    disabled={running ? !onStop : disabled} onClick={stoppable ? onStop : onTest}>
    <Icon name={stoppable ? 'stop' : running ? 'refresh' : restart ? 'restart' : kind === 'connection' ? 'link' : 'play-circle'}
      size={compact && !iconOnly ? 14 : 16} tone="neutral" className={running && !stoppable ? 'st-model-test-button-spinner' : undefined} />
    {!iconOnly && <span>{stoppable ? '停止测试' : running ? '测试中…' : label}</span>}
    </Button>} />
    <Tooltip.Portal container={container ?? undefined}>
      <Tooltip.Positioner side="top" align="start" sideOffset={8} collisionPadding={12} collisionBoundary={container ?? undefined}>
        <Tooltip.Popup id={tooltipId} role="tooltip" className="st-model-test-tooltip">{iconOnly ? `${accessibleLabel}：${tip}` : tip}</Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  </Tooltip.Root>
}
