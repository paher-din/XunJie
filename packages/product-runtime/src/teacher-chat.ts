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

export function teacherChatGateway(gateway: LearningModelPort,
  teacherSelection: Pick<LearningModelPort['selection'], 'read' | 'pin'>): LearningModelPort {
  return { ...gateway, selection: { ...gateway.selection,
    async read(identity) {
      const selection = await teacherSelection.read(identity);
      if (!selection.selected) throw new AgentError('teacher-model-unavailable');
      return selection;
    },
    async pin(identity, pinId, expectedVersion) {
      return teacherSelection.pin(identity, pinId, expectedVersion)
        .catch(() => { throw new AgentError('teacher-model-unavailable'); });
    },
  } };
}
