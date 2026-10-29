import type { TutorCommand, TutorMessage } from '../../workspace/tutoringStore'

/** Pair only by the acknowledged Job identity, never question text or arrival timing. */
export function tutorTranscript(commands: TutorCommand[], messages: TutorMessage[]) {
  const used = new Set<string>()
  const rows = commands.filter(c => c.kind === 'help').map(command => {
    const jobId = (command.result as { result?: { jobId?: string } } | undefined)?.result?.jobId
    const replies = jobId ? messages.filter(m => m.payload.jobId === jobId) : []
    replies.forEach(m => used.add(m.payload.actionId))
    return { key: command.key, command, messages: replies }
  })
  // Older client channels can have a reply without a local command; preserve it.
  return [...messages.filter(m => !used.has(m.payload.actionId)).map(m => ({
    key: m.payload.actionId, command: undefined, messages: [m],
  })), ...rows]
}
