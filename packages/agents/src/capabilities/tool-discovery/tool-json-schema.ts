export const uuid = { type: 'string', minLength: 36, maxLength: 36 };
export const objectSchema = (properties: Record<string, unknown>) => ({ type: 'object', properties,
  required: Object.keys(properties), additionalProperties: false });
