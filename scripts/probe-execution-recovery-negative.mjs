#!/usr/bin/env node
import { probeEvidenceDirectory, writeEvidence, mkdtemp } from './lib/probe-evidence.mjs';
/**
 * #188 negative recovery cases on a real client product package.
 *
 * Every case runs against the actual packaged runtime and its native PostgreSQL.
 * The probe creates one real held backup, then works only on copies of that
 * backup (or on isolated restored targets). It never touches the school node,
 * the source installation or the original backup, and never changes product code.
 * Refusals are observed from the product's own recovery API; no mock decides
 * the outcome.
 *
 * Usage:
 *   node scripts/probe-execution-recovery-negative.mjs <PACKAGE> <OUTPUT> [--label=NAME]
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'out': { type: 'string' }, 'output': { type: 'string' }, 'evidence-dir': { type: 'string' },  label: { type: 'string' } } });
const product = resolve(positionals[0] ?? '');
const output = probeEvidenceDirectory(positionals[1]);
await mkdir(output, { recursive: true });
const runtime = await import(pathToFileURL(join(product, 'app/product-runtime.js')).href);
const resourcePaths = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'));
const resources = { ...resourcePaths };
for (const name of ['nodePath', 'postgresBin', 'webRoot', 'windowsPrerequisitePath', 'windowsSessionHelper'])
  if (resources[name]) resources[name] = resolve(product, resources[name]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = await mkdtemp(join(tmpdir(), 'xunjie-188-negative-'));
const sourceRoot = join(root, 'source');
const source = runtime.openProductRuntime({ root: sourceRoot, resources });
const report = { label: values.label ?? `${process.platform}-${process.arch}`, platform: process.platform, arch: process.arch,
  os: release(), node: process.version, product, packageSha256: hash(await readFile(join(product, 'distribution.json'))),
  postgresVersion: resources.postgresVersion ?? null, cases: [], status: 'running', startedAt: new Date().toISOString() };
const pass = (name, detail) => { report.cases.push({ name, ...detail }); console.log('PASS ' + name + ' ' + JSON.stringify(detail)); };
const opened = [];
const startedTargets = [];

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(file));
    else result.push(file);
  }
  return result;
}
/** A byte-exact fingerprint of every file in a backup directory. */
async function fingerprint(directory) {
  const files = (await walk(directory)).sort();
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(relative(directory, file).split('\\').join('/'));
    digest.update(await readFile(file));
  }
  return { files: files.length, sha256: digest.digest('hex') };
}
async function restore(backupDirectory, targetRoot, key) {
  const restored = await runtime.restoreProductRecovery({ root: targetRoot, backupDirectory, key, resources });
  opened.push(restored);
  return restored;
}
async function refused(name, fn, targetRoot, expectedDetail) {
  let error;
  try { await fn(); } catch (caught) { error = caught; }
  assert.ok(error, `${name}: the product must refuse, not silently succeed`);
  const stateFile = join(targetRoot, 'recovery-state.json');
  let phase = null;
  try { phase = JSON.parse(await readFile(stateFile, 'utf8')).phase; } catch { /* no state was published */ }
  assert.notEqual(phase, 'active', `${name}: a failed recovery must never become active`);
  const detail = { code: error.code ?? error.name, message: String(error.message ?? error).slice(0, 160),
    ...(error.path ? { missingPath: String(error.path).slice(0, 160) } : {}), targetPhase: phase,
    ...expectedDetail };
  return detail;
}

let backupDirectory, key, manifest;
try {
  await source.install({ profile: 'local' });
  const { endpoint } = await source.start();
  assert.ok(endpoint.startsWith('http'), 'the real product service must start');
  key = randomBytes(32);
  await source.setCredential('recovery-negative-key', key.toString('base64'));
  manifest = await source.recovery.backup({ directory: join(root, 'backups'),
    recoveryKeyRef: 'recovery-negative-key', leaveClosed: true });
  backupDirectory = join(root, 'backups', manifest.backupId);
  report.backupId = manifest.backupId;
  report.boundaryServices = manifest.boundary.services.length;
  report.backupFingerprint = await fingerprint(backupDirectory);
  assert.ok(report.backupFingerprint.files > 1, 'the held backup must contain real encrypted artifacts');

  const artifacts = (await walk(join(backupDirectory, 'artifacts'))).sort();
  assert.ok(artifacts.length > 0, 'the backup must contain encrypted resource artifacts');
  let pick = artifacts[0];
  for (const file of artifacts) {
    const info = await stat(file);
    if (info.size > 64) { pick = file; break; }
  }

  // 1. A missing resource file must fail closed before anything is published.
  {
    const name = 'a backup missing one resource artifact is refused without publishing an active target';
    const copy = join(root, 'case-missing'), targetRoot = join(root, 'target-missing');
    await cp(backupDirectory, copy, { recursive: true });
    const victim = join(copy, 'artifacts', relative(join(backupDirectory, 'artifacts'), pick));
    await rm(victim);
    const detail = await refused(name, () => restore(copy, targetRoot, key), targetRoot,
      { mutation: 'removed-artifact', removed: relative(copy, victim).split('\\').join('/') });
    pass(name, detail);
  }

  // 2. A single flipped ciphertext byte must be detected by the authenticated inventory.
  {
    const name = 'a backup with one corrupted resource byte is refused without publishing an active target';
    const copy = join(root, 'case-corrupt'), targetRoot = join(root, 'target-corrupt');
    await cp(backupDirectory, copy, { recursive: true });
    const victim = join(copy, 'artifacts', relative(join(backupDirectory, 'artifacts'), pick));
    const bytes = Buffer.from(await readFile(victim));
    const offset = Math.max(1, Math.floor(bytes.length / 2));
    bytes[offset] ^= 0x01;
    await writeFile(victim, bytes);
    const detail = await refused(name, () => restore(copy, targetRoot, key), targetRoot,
      { mutation: 'flipped-ciphertext-byte', artifact: relative(copy, victim).split('\\').join('/'), byteOffset: offset });
    pass(name, detail);
  }

  // 3. An altered public manifest must fail its authentication MAC.
  {
    const name = 'an altered backup manifest is refused even though the JSON still parses';
    const copy = join(root, 'case-manifest'), targetRoot = join(root, 'target-manifest');
    await cp(backupDirectory, copy, { recursive: true });
    const file = join(copy, 'manifest.json');
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    parsed.backupId = '00000000-0000-4000-8000-000000000000';
    await writeFile(file, JSON.stringify(parsed));
    const detail = await refused(name, () => restore(copy, targetRoot, key), targetRoot,
      { mutation: 'manifest-identity-rewritten' });
    pass(name, detail);
  }

  // 4. A different recovery key must not open the original backup.
  {
    const name = 'the original backup is refused under a different recovery key';
    const targetRoot = join(root, 'target-wrong-key');
    const detail = await refused(name, () => restore(backupDirectory, targetRoot, randomBytes(32)), targetRoot,
      { mutation: 'wrong-key', originalBackupUsed: true });
    pass(name, detail);
  }

  // 5. A restored target carrying legacy/history-only state must stay isolated and
  //    refuse authority transfer with the product's own boundary error.
  {
    const name = 'a legacy restore state without complete boundary material refuses takeover and stays isolated';
    const targetRoot = join(root, 'target-legacy');
    await restore(backupDirectory, targetRoot, key);
    const targetRuntime = runtime.openProductRuntime({ root: targetRoot, resources });
    // A restored target must actually run its packaged PostgreSQL/HTTP service before
    // the recovery manager can evaluate authority transfer (it needs instance.json).
    assert.equal((await targetRuntime.start()).state, 'maintenance');
    startedTargets.push(targetRuntime);
    const stateFile = join(targetRoot, 'recovery-state.json');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(state.phase, 'isolated');
    const { boundary: _boundary, ...legacyManifest } = state.manifest;
    await writeFile(stateFile, JSON.stringify({ ...state, legacy: true, manifest: legacyManifest }));
    const detail = await refused(name,
      () => targetRuntime.recovery.takeover({ sourceRoot, receivers: [] }),
      targetRoot, { mutation: 'legacy-state-without-boundary' });
    assert.equal(detail.code, 'boundary-material-required', 'the refusal must come from missing boundary evidence');
    assert.equal(detail.targetPhase, 'isolated', 'the target must stay isolated for a retry');
    pass(name, detail);
  }

  // 6. A boundary reporting an unresolved/blocking owner must not be publishable as
  //    a complete maintenance success, even when everything else looks valid.
  {
    const name = 'a boundary with a blocking owner refuses takeover and keeps the target isolated';
    const targetRoot = join(root, 'target-blocking');
    await restore(backupDirectory, targetRoot, key);
    const targetRuntime = runtime.openProductRuntime({ root: targetRoot, resources });
    assert.equal((await targetRuntime.start()).state, 'maintenance');
    startedTargets.push(targetRuntime);
    const stateFile = join(targetRoot, 'recovery-state.json');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    state.manifest.boundary.services[0].blocking = 1;
    await writeFile(stateFile, JSON.stringify(state));
    const detail = await refused(name,
      () => targetRuntime.recovery.takeover({ sourceRoot, receivers: [] }),
      targetRoot, { mutation: 'blocking-owner-boundary' });
    assert.equal(detail.code, 'boundary-material-required', 'an unconfirmed node must not produce a complete maintenance success');
    assert.equal(detail.targetPhase, 'isolated');
    pass(name, detail);
  }

  // Nothing above may have touched the source or the original held backup.
  report.backupFingerprintAfter = await fingerprint(backupDirectory);
  assert.deepEqual(report.backupFingerprintAfter, report.backupFingerprint,
    'the original backup must be byte-identical after all negative cases');
  let retired = false;
  try { await stat(join(sourceRoot, 'retired.json')); retired = true; } catch { /* expected */ }
  assert.equal(retired, false, 'negative cases must not retire the source installation');
  report.sourceRetired = false;
  pass('the source installation and the original held backup are retained byte-for-byte',
    { originalBackupFiles: report.backupFingerprint.files, originalBackupSha256: report.backupFingerprint.sha256,
      sourceRetired: false });

  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error.stack ?? error).slice(0, 2000);
  console.error('NEGATIVE_FAILED ' + report.error);
} finally {
  for (const restored of opened) for (const owner of restored.owners ?? []) await owner.close?.().catch(() => {});
  await Promise.allSettled(startedTargets.map(item => item.stop()));
  await source.stop().catch(() => {});
  await rm(root, { recursive: true, force: true });
  report.temporaryRootRemoved = true;
  report.finishedAt = new Date().toISOString();
  await writeEvidence(join(output, 'negative.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('NEGATIVE_STATUS ' + report.status + ' cases=' + report.cases.length);
  if (report.status !== 'passed') process.exitCode = 1;
}
