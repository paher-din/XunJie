import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { acquireLock, atomicJson, exists, readJson } from './io.js';
import { isInstallationRetired } from './retired-installations.js';

const schema = z.object({ formatVersion: z.literal(1), backupId: z.uuid(), sourceEnvironmentId: z.uuid(),
  sourceServiceId: z.uuid(), sourceInstallationId: z.uuid(), targetInstallationId: z.uuid() }).strict();
type Succession = z.infer<typeof schema>;
const directory = (root: string) => join(root, 'private', 'recovery-successions');
const name = (fact: Pick<Succession, 'sourceInstallationId' | 'sourceServiceId'>) => `${fact.sourceInstallationId}-${fact.sourceServiceId}.json`;

/** Called only by authenticated receiver maintenance after real fencing and owner validation. */
export async function recordRecoverySuccession(root: string, value: unknown): Promise<void> {
  const fact = schema.parse(value);
  if (fact.sourceInstallationId === fact.targetInstallationId || !await isInstallationRetired(root, fact.sourceInstallationId))
    throw new Error('Recovery succession requires a retired source installation.');
  const release = await acquireLock(root, 'succession-' + fact.sourceServiceId);
  try {
  const file = join(directory(root), name(fact));
  if (await exists(file)) {
    if (JSON.stringify(schema.parse(await readJson(file))) !== JSON.stringify(fact)) throw new Error('Recovery succession conflict.');
    return;
  }
  await mkdir(directory(root), { recursive: true, mode: 0o700 }); await atomicJson(file, fact);
  } finally { await release(); }
}

/** The logical owner stays fixed. A new installation still needs its own current WP01 grant. */
export async function isRecoverySuccessor(root: string, source: Pick<Succession, 'sourceEnvironmentId' | 'sourceServiceId' | 'sourceInstallationId'>,
  targetInstallationId: string): Promise<boolean> {
  z.uuid().parse(targetInstallationId);
  let installationId = source.sourceInstallationId;
  const seen = new Set<string>();
  while (installationId !== targetInstallationId) {
    if (seen.has(installationId) || seen.size >= 64 || !await isInstallationRetired(root, installationId)) return false;
    seen.add(installationId);
    const file = join(directory(root), name({ sourceInstallationId: installationId, sourceServiceId: source.sourceServiceId }));
    if (!await exists(file)) return false;
    const fact = schema.parse(await readJson(file));
    if (fact.sourceEnvironmentId !== source.sourceEnvironmentId || fact.sourceServiceId !== source.sourceServiceId
      || fact.sourceInstallationId !== installationId) throw new Error('Invalid recovery succession identity.');
    installationId = fact.targetInstallationId;
  }
  return true;
}

export async function recoverySuccessions(root: string): Promise<Succession[]> {
  const files = await readdir(directory(root)).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const result = [];
  for (const file of files.sort()) {
    const fact = schema.parse(await readJson(join(directory(root), file)));
    if (name(fact) !== file || !await isInstallationRetired(root, fact.sourceInstallationId)) throw new Error('Invalid recovery succession.');
    result.push(fact);
  }
  return result;
}
/** Ordered, retired predecessors of a currently authenticated installation, for a host permit.
 * No credential, activity input or caller-supplied succession fact can populate this chain.
 */
export async function recoveryPredecessors(root: string, service: { environmentId: string; serviceId: string }, installationId: string): Promise<Succession[]> {
  z.uuid().parse(installationId);
  const facts = (await recoverySuccessions(root)).filter(fact => fact.sourceEnvironmentId === service.environmentId
    && fact.sourceServiceId === service.serviceId);
  const chain: Succession[] = [], seen = new Set([installationId]);
  let current = installationId;
  while (true) {
    const previous = facts.filter(fact => fact.targetInstallationId === current);
    if (!previous.length) return chain.reverse();
    if (previous.length !== 1 || seen.has(previous[0]!.sourceInstallationId) || chain.length >= 64)
      throw new Error('Invalid recovery predecessor chain.');
    const fact = previous[0]!;
    chain.push(fact); current = fact.sourceInstallationId; seen.add(current);
  }
}
export async function restoreRecoverySuccessions(root: string, value: unknown): Promise<void> {
  for (const fact of z.array(schema).parse(value)) await recordRecoverySuccession(root, fact);
}

export async function hasRecoverySuccession(root: string, source: Pick<Succession, 'sourceEnvironmentId' | 'sourceServiceId' | 'sourceInstallationId'>) {
  return (await recoverySuccessions(root)).some(fact => fact.sourceEnvironmentId === source.sourceEnvironmentId
    && fact.sourceServiceId === source.sourceServiceId && fact.sourceInstallationId === source.sourceInstallationId
    && fact.targetInstallationId !== source.sourceInstallationId);
}
