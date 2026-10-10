import type { z } from 'zod';
import { ApiError } from './errors.ts';

export function parseRequest<Schema extends z.ZodType>(schema: Schema, input: unknown): z.output<Schema> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError('INVALID_REQUEST');
  }
  return result.data;
}
