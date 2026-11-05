import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicJson, exists, readJson } from './io.js';

const retirementSchema = z.object({ formatVersion: z.literal(1), installationId: z.uuid(), fencedAt: z.iso.datetime() }).strict();
export type RetiredInstallation = z.infer<typeof retirementSchema>;
const directory = (root: string) => join(root, 'private', 'retired-installations');
const path = (root: string, installationId: string) => join(directory(root), `${z.uuid().parse(installationId)}.json`);

/** One monotonic fact is shared by connection admission and authenticated native pull channels. */
export async function isInstallationRetired(root: string, installationId: string): Promise<boolean> {
  const file = path(root, installationId);
  if (!await exists(file)) return false;
  const fact = retirementSchema.parse(await readJson(file));
  if (fact.installationId !== installationId) throw new Error('Invalid retirement identity.');
  return true;
}
export async function retireInstallation(root: string, installationId: string): Promise<void> {
  if (await isInstallationRetired(root, installationId)) return;
  await mkdir(directory(root), { recursive: true, mode: 0o700 });
  await atomicJson(path(root, installationId), { formatVersion: 1, installationId, fencedAt: new Date().toISOString() });
}
export async function retiredInstallations(root: string): Promise<RetiredInstallation[]> {
  const names = await readdir(directory(root)).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const facts: RetiredInstallation[] = [];
  for (const name of names.sort()) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : '';
    z.uuid().parse(id);
    const fact = retirementSchema.parse(await readJson(path(root, id)));
    if (fact.installationId !== id) throw new Error('Invalid retirement identity.');
    facts.push(fact);
  }
  return facts;
}
/** Restore immutable rejection facts, never the old connection secrets that they revoked. */
export async function restoreRetiredInstallations(root: string, value: unknown): Promise<void> {
  const facts = z.array(retirementSchema).parse(value);
  if (new Set(facts.map(item => item.installationId)).size !== facts.length) throw new Error('Duplicate retirement identity.');
  if (facts.length) await mkdir(directory(root), { recursive: true, mode: 0o700 });
  for (const fact of facts) await atomicJson(path(root, fact.installationId), fact);
}
