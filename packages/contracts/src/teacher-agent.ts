import { z } from 'zod';
import { teachingSkillReferenceSchema } from './agent-skills.js';

export const teacherReleaseReferenceSchema = z.object({
  taskId: z.uuid(), releaseId: z.uuid(),
}).strict();

export const teacherChatInputContextSchema = z.object({
  teacherTarget: teacherReleaseReferenceSchema.extend({ kind: z.literal('release') }).optional(),
  teacherSkill: teachingSkillReferenceSchema.optional(),
}).strict();
