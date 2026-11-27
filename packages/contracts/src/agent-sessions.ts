import { z } from 'zod';
import { learningTargetSchema, spaceIdentitySchema } from './spaces.js';
import { teachingAgentBindingSchema } from './teaching-agent.js';
import { agentInputSchema } from './agent-runtime.js';

export const agentSessionScenarioSchema = z.enum(['student-assistant', 'workspace-assistant', 'teacher-assistant']);
export type AgentSessionScenario = z.infer<typeof agentSessionScenarioSchema>;
export const agentSessionWorkspaceSchema = z.object({ activityId: z.uuid(), target: learningTargetSchema }).strict();
export type AgentSessionWorkspace = z.infer<typeof agentSessionWorkspaceSchema>;
const titleSchema = z.string().trim().min(1).max(200).nullable();
const placement = (value: { scenario: AgentSessionScenario; workspace?: AgentSessionWorkspace | undefined; courseId?: string | undefined }) =>
  (value.scenario === 'workspace-assistant') === (value.workspace !== undefined)
  && (value.scenario === 'teacher-assistant') === (value.courseId !== undefined);

/** The host resolves the owner; callers only choose a stable conversation identity. */
export const createAgentSessionSchema = z.object({ requestId: z.uuid(), sessionId: z.uuid(),
  scenario: agentSessionScenarioSchema, workspace: agentSessionWorkspaceSchema.optional(), courseId: z.uuid().optional(),
  title: titleSchema.optional() }).strict().refine(placement, 'Workspace sessions require a workspace and teacher sessions require a course.');
export type CreateAgentSession = z.infer<typeof createAgentSessionSchema>;

export const startAgentSessionSchema = z.object({ create: createAgentSessionSchema, input: agentInputSchema }).strict()
  .refine(value => value.create.sessionId === value.input.sessionId && value.create.scenario !== 'workspace-assistant',
    'The first input must belong to the new standalone session.');

export const agentSessionSchema = z.object({ sessionId: z.uuid(), requestId: z.uuid(), identity: spaceIdentitySchema,
  scenario: agentSessionScenarioSchema, owner: teachingAgentBindingSchema, workspace: agentSessionWorkspaceSchema.optional(), courseId: z.uuid().optional(),
  title: titleSchema, pinned: z.boolean(), archived: z.boolean(), deleted: z.boolean(),
  state: z.enum(['initializing', 'ready']), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  readyAt: z.iso.datetime().nullable(),
}).strict().refine(placement, 'Workspace sessions require a workspace and teacher sessions require a course.')
  .refine(value => (value.state === 'ready') === (value.readyAt !== null), 'Ready sessions require their initialization time.');
export type AgentSession = z.infer<typeof agentSessionSchema>;

/** Metadata changes cannot replace the identity, placement or fixed owner. */
export const updateAgentSessionSchema = z.object({ requestId: z.uuid(), sessionId: z.uuid(),
  title: titleSchema.optional(), pinned: z.boolean().optional(), archived: z.boolean().optional(), deleted: z.boolean().optional(),
}).strict().refine(value => [value.title, value.pinned, value.archived, value.deleted].some(field => field !== undefined),
  'At least one metadata change is required.');
export type UpdateAgentSession = z.infer<typeof updateAgentSessionSchema>;
export const markAgentSessionReadySchema = z.object({ requestId: z.uuid(), sessionId: z.uuid() }).strict();
export type MarkAgentSessionReady = z.infer<typeof markAgentSessionReadySchema>;
