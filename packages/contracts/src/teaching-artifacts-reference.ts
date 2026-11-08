import { z } from 'zod';
const objectId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,47}$/);
export const teachingArtifactReferenceAdapters = {
  'teaching-artifact-objects': { version: 1, origin: 'state', target: z.object({ objectIds: z.array(objectId).min(1).max(64) }).strict() },
  'teaching-artifact-text': { version: 1, origin: 'state', target: z.object({ text: z.string().min(1).max(20000) }).strict() },
} as const;
export function normalizeTeachingArtifactReferenceTarget(typeId: string, value: unknown): Record<string, unknown> {
  if (typeId === 'teaching-artifact-text') return teachingArtifactReferenceAdapters[typeId].target.parse(value);
  if (typeId !== 'teaching-artifact-objects') throw new Error('unsupported-version');
  const target = teachingArtifactReferenceAdapters[typeId].target.parse(value);
  return { objectIds: [...new Set(target.objectIds)].sort() };
}
export function teachingArtifactText(html: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return html.replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, '').replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
      if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? match;
      const code = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }).replace(/\s+/g, ' ').trim();
}
/** Copy is derived from a retained revision, never arbitrary text supplied by an iframe. */
export function teachingArtifactReferenceCopy(typeId: string, targetValue: unknown, value: unknown): string {
  const target = normalizeTeachingArtifactReferenceTarget(typeId, targetValue);
  const content = z.object({ html: z.string(), semanticObjects: z.array(z.object({ id: objectId, meaning: z.string(), summary: z.string() })) }).passthrough().parse(value);
  if (typeId === 'teaching-artifact-text') {
    const text = target.text as string;
    if (!text.trim() || !teachingArtifactText(content.html).includes(text.replace(/\s+/g, ' ').trim())) throw new Error('invalid-input');
    return text;
  }
  return (target.objectIds as string[]).map(id => {
    const object = content.semanticObjects.find(item => item.id === id); if (!object) throw new Error('invalid-input');
    return `${object.meaning}\n${object.summary}`;
  }).join('\n\n');
}
