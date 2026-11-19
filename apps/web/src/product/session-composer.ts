import type { AgentSessionController } from './useAgentSession'

/** The composer is the single home for sending, stopping and continuing. */
export function sessionComposerActions(controller: AgentSessionController | undefined, readOnly: boolean) {
  const runs = controller?.conversation?.turns ?? []
  const active = [...runs].reverse().find(run => run.state === 'active')
  const latest = runs.at(-1)
  const resumable = !active && latest && ['stopped', 'failed', 'interrupted'].includes(latest.state) ? latest : undefined
  return {
    active: !!active, canResume: !!resumable, disabled: readOnly || !!controller?.busy,
    error: controller?.error ?? '',
    stop: () => { if (active && !readOnly) void controller?.control(active.turnId, 'stop').catch(() => {}) },
    resume: () => { if (resumable && !readOnly) void controller?.control(resumable.turnId, 'continue').catch(() => {}) },
  }
}
