import { z } from 'zod';

export const teachingInputModeSchema = z.enum(['steering', 'queue']);
/** Optional, versioned addition; parsing old reliable inputs must not inject fields into their hashed bytes. */
export const teachingInputDeliverySchema = z.object({ version: z.literal(1), mode: teachingInputModeSchema,
  basis: z.object({ source: z.enum(['preference', 'explicit']), preferenceVersion: z.number().int().nonnegative() }).strict(),
}).strict();
export const teachingInteractionSettingsSchema = z.object({
  version: z.number().int().nonnegative(), busyInputMode: teachingInputModeSchema,
}).strict();
export type TeachingInteractionSettings = z.infer<typeof teachingInteractionSettingsSchema>;
export const teachingInteractionSettingsInputSchema = z.object({
  requestId: z.uuid(), expectedVersion: z.number().int().nonnegative(), busyInputMode: teachingInputModeSchema,
}).strict();
