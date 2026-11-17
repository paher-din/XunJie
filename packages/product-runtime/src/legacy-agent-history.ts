import { StorageError, type OwnedStorage } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { agentRuntimeSessionSchema } from '@xunjie/contracts/agent-runtime';
import { agentConversationSchema, type AgentConversation } from '@xunjie/contracts/agent-service';

/** Offline import only. Historical effects are presentation data, never executable kernel Turns. */
export async function importLegacyAgentHistory(storage: OwnedStorage, value: {
  session: unknown; conversation: unknown; source: { activityId: string; digest: string };
}) {
  const session = agentRuntimeSessionSchema.parse(value.session);
  const conversation = agentConversationSchema.parse(value.conversation);
  if (conversation.sessionId !== session.sessionId || conversation.lastSeq !== 0
    || conversation.questions.length || conversation.turns.some(turn => turn.state !== 'completed' || turn.sessionId !== session.sessionId)
    || conversation.tools.some(tool => tool.state !== 'closed')
    || conversation.inputs.some(input => input.canEdit !== false)
    || conversation.thinking?.some(item => item.active)
    || !/^[a-f0-9]{64}$/.test(value.source.digest)) throw new StorageError('incompatible');
  const body = { source: { kind: 'legacy-teaching', ...value.source }, conversation };
  await storage.request({ requestId: 'agent-session:' + session.sessionId, fingerprint: canonicalDigest(session) }, async tx => {
    await tx.query('INSERT INTO agent_runtime_sessions(session_id,body) VALUES($1,$2)', [session.sessionId, session]);
    return session;
  });
  return storage.request({ requestId: 'legacy-agent-history:' + session.sessionId, fingerprint: canonicalDigest(body) }, async tx => {
    const { rows: [saved] } = await tx.query('SELECT next_seq,state FROM agent_runtime_sessions WHERE session_id=$1 FOR UPDATE', [session.sessionId]);
    if (!saved || Number(saved.next_seq) !== 1 || Object.keys(saved.state as object).length
      || (await tx.query('SELECT 1 FROM agent_turns WHERE session_id=$1 LIMIT 1', [session.sessionId])).rowCount)
      throw new StorageError('conflict');
    const history = conversation.messages.map(message => ({ id: message.inputId ?? message.messageId,
      version: conversation.inputs.find(input => input.inputId === message.inputId)?.version ?? 1,
      role: message.role, text: message.text }));
    await tx.query('UPDATE agent_runtime_sessions SET state=$2,next_seq=2 WHERE session_id=$1',
      [session.sessionId, { history, importedHistory: value.source }]);
    await tx.query(`INSERT INTO agent_events(session_id,seq,event_id,kind,body) VALUES($1,1,$2,'history-imported',$3)`,
      [session.sessionId, operationId('legacy-agent-history:' + session.sessionId), body]);
    return { messages: conversation.messages.length, tools: conversation.tools.length, thinking: conversation.thinking?.length ?? 0 };
  });
}

/** A full read includes the immutable archive; normal incremental reads only carry new kernel facts. */
export function importedAgentConversation(sessionId: string, body: Record<string, unknown>): AgentConversation {
  const conversation = agentConversationSchema.parse(body.conversation);
  if (conversation.sessionId !== sessionId || conversation.lastSeq !== 0) throw new StorageError('corrupt');
  // A legacy continuation could adopt an input in a later Run than its original user bubble.
  // Those Runs use the normal standalone trace anchor rather than a nonexistent input bubble.
  const anchored = <T extends { turnId: string; inputId?: string }>(item: T): T => {
    if (!item.inputId || conversation.messages.some(message => message.role === 'user'
      && message.turnId === item.turnId && message.inputId === item.inputId)) return item;
    const { inputId: _inputId, ...standalone } = item;
    return standalone as T;
  };
  return { ...conversation, thinking: conversation.thinking?.map(anchored), tools: conversation.tools.map(anchored) };
}
