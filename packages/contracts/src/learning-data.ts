import { z } from 'zod';
import { spaceIdentitySchema, learningTargetSchema } from './spaces.js';

/** Learning-data owner wire. Course releases and works have their own subsequent contracts. */
export const createActivitySchema = z.object({ requestId: z.uuid(), goal: z.string().max(4000),
  question: z.string().max(10000), references: z.array(z.object({ kind: z.literal('url'),
    url: z.url().refine(value => /^https:\/\//.test(value)), label: z.string().min(1).max(300) }).strict()).max(50),
}).strict().refine(value => !!(value.goal.trim() || value.question.trim() || value.references.length));
export type CreateActivity = z.infer<typeof createActivitySchema>;
export const activitySchema = z.object({ activityId: z.uuid(), identity: spaceIdentitySchema,
  target: learningTargetSchema, goal: z.string(), question: z.string(), references: createActivitySchema.shape.references,
  status: z.enum(['open', 'closed']), createdAt: z.string() }).strict();
export type LearningActivity = z.infer<typeof activitySchema>;
