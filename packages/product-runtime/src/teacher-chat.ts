import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { AgentError } from '@xunjie/agent-runtime';
import type { LearningModelPort } from '@xunjie/model-gateway/service';

const positive = z.number().int().positive();
const configSchema = z.object({
  grants: z.array(z.object({ spaceId: z.uuid(), principalId: z.uuid(), courseId: z.uuid() }).strict()),
  connectionId: z.uuid().optional(),
  budget: z.object({ maxSteps: positive, maxToolCalls: positive, maxInputTokens: positive,
    maxOutputTokens: positive, maxCallMs: positive, hardDeadlineMs: positive }).strict(),
}).strict();

/** Reload the host-owned grants so a removed grant revokes existing chats. */
export async function readTeacherChatConfig(root: string) {
  try {
    return configSchema.parse(JSON.parse(await readFile(join(root, 'teacher-chat.json'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function teacherChatGateway(gateway: LearningModelPort, connectionId?: string): LearningModelPort {
  const source = connectionId ? { kind: 'school' as const, connectionId } : null;
  return { ...gateway, selection: { ...gateway.selection,
    async read(identity) {
      if (!source) throw new AgentError('teacher-model-unavailable');
      const fixed = await gateway.selection.resolveChoice(identity, source)
        .catch(() => { throw new AgentError('teacher-model-unavailable'); });
      return { version: 0, selected: fixed.choice, options: [] };
    },
    async pin(identity, pinId, expectedVersion) {
      if (!source) throw new AgentError('teacher-model-unavailable');
      return gateway.selection.pinSource(identity, pinId, expectedVersion, source)
        .catch(() => { throw new AgentError('teacher-model-unavailable'); });
    },
  } };
}
