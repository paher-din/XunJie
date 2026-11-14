import { z } from 'zod';
import { learningTargetSchema, spaceIdentitySchema } from './spaces.js';
import { teachingAgentBindingSchema } from './teaching-agent.js';

export const agentSessionScenarioSchema = z.enum(['student-assistant', 'workspace-assistant']);
export type AgentSessionScenario = z.infer<typeof agentSessionScenarioSchema>;
export const agentSessionWorkspaceSchema = z.object({ activityId: z.uuid(), target: learningTargetSchema }).strict();
export type AgentSessionWorkspace = z.infer<typeof agentSessionWorkspaceSchema>;
const titleSchema = z.string().trim().min(1).max(200).nullable();
const placement = (value: { scenario: AgentSessionScenario; workspace?: AgentSessionWorkspace | undefined }) =>
  (value.scenario === 'workspace-assistant') === (value.workspace !== undefined);

/** The host resolves the owner; callers only choose a stable conversation identity. */
export const createAgentSessionSchema = z.object({ requestId: z.uuid(), sessionId: z.uuid(),
  scenario: agentSessionScenarioSchema, workspace: agentSessionWorkspaceSchema.optional(),
  title: titleSchema.optional() }).strict().refine(placement, 'Workspace sessions require an activity and learning target.');
export type CreateAgentSession = z.infer<typeof createAgentSessionSchema>;

export const agentSessionSchema = z.object({ sessionId: z.uuid(), requestId: z.uuid(), identity: spaceIdentitySchema,
  scenario: agentSessionScenarioSchema, owner: teachingAgentBindingSchema, workspace: agentSessionWorkspaceSchema.optional(),
  title: titleSchema, pinned: z.boolean(), archived: z.boolean(), deleted: z.boolean(),
  state: z.enum(['initializing', 'ready']), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  readyAt: z.iso.datetime().nullable(),
}).strict().refine(placement, 'Workspace sessions require an activity and learning target.')
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
