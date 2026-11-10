import { z } from 'zod';

/** Space/course owner wire: no deployment secrets or database implementation. */
export const spaceIdentitySchema = z.object({ environmentId: z.uuid(), spaceId: z.uuid(), principalId: z.uuid(),
  kind: z.enum(['personal', 'school']), name: z.string().min(1).max(200) }).strict();
export type SpaceIdentity = z.infer<typeof spaceIdentitySchema>;
/** Account presentation is independent of the activity's data scope. */
export const schoolAccountSchema = z.object({ accountName: z.string().min(1).max(200),
  schoolName: z.string().min(1).max(200) }).strict();
export type SchoolAccount = z.infer<typeof schoolAccountSchema>;
export const memberPermissionSchema = z.literal('course.manage');
export const memberPermissionInputSchema = z.object({ requestId: z.uuid(), principalId: z.uuid(),
  permission: memberPermissionSchema, enabled: z.boolean() }).strict();
export type MemberPermission = z.infer<typeof memberPermissionSchema>;
export const learningTargetSchema = z.object({ environmentId: z.uuid(), serviceId: z.uuid(), version: z.literal(1) }).strict();
export type LearningTarget = z.infer<typeof learningTargetSchema>;
export interface SpaceAuthority {
  resolveBinding(identity: SpaceIdentity): Promise<LearningTarget>;
}
