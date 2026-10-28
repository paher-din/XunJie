// Research fixtures only. No real credentials, providers, student data, or tool effects.
export const toolCallId = 'fixture-course-call-1';
export const toolName = 'course_observe';
export const toolInput = { objectRef: 'fixture-alu-v1' };
export const rawByProtocol = {
  chat: {
    id: 'fixture-chat-response',
    choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null,
      reasoning_content: 'fixture reasoning',
      reasoning_details: [{ type: 'fixture-opaque', data: 'uninterpreted-fixture-value' }],
      tool_calls: [{ id: toolCallId, type: 'function', function: {
        name: toolName, arguments: JSON.stringify(toolInput),
      } }],
    } }],
  },
  responses: {
    id: 'fixture-responses-response', status: 'completed',
    output: [
      { id: 'fixture-reasoning-item', type: 'reasoning', encrypted_content: 'fixture-not-encrypted', summary: [] },
      { type: 'fixture-opaque-extension', payload: { keep: ['as', 'received'] } },
      { type: 'function_call', id: 'fixture-function-item', call_id: toolCallId,
        name: toolName, arguments: JSON.stringify(toolInput), status: 'completed' },
    ],
  },
  messages: {
    id: 'fixture-messages-response', type: 'message', role: 'assistant', stop_reason: 'tool_use',
    content: [
      { type: 'thinking', thinking: 'fixture reasoning', signature: 'fixture-signature-not-a-secret' },
      { type: 'redacted_thinking', data: 'fixture-redacted-data' },
      { type: 'tool_use', id: toolCallId, name: toolName, input: toolInput },
    ],
  },
};

export function nativeFixture(protocol) {
  return structuredClone(rawByProtocol[protocol]);
}
