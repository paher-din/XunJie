import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// One authorized local rollout. No credentials, database, backend or runner writes.
const root = '/opt/xunjie-ui-local';
const release = path.join(root, 'releases/board-static-cffa6e6-20261015');
const incoming = path.join(release, 'incoming');
const live = path.join(root, 'student-dist');
const expectedIndex = '280c205e362469e57a489c5379c88b35fe9d4a66cb14ea8dc60d058f562472bf';
const sourceHead = 'cffa6e6';
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function files(base, sub = '') {
  const result = [];
  for (const name of fs.readdirSync(path.join(base, sub)).sort()) {
    const relative = path.join(sub, name), full = path.join(base, relative), stat = fs.lstatSync(full);
    assert(!stat.isSymbolicLink(), 'Static rollout requires ordinary paths');
    if (stat.isDirectory()) result.push(...files(base, relative));
    else { assert(stat.isFile()); result.push({ path: relative, sha256: hash(full) }); }
  }
  return result;
}
assert.equal(process.platform, 'linux');
for (const p of [root, release, incoming, live]) assert(fs.lstatSync(p).isDirectory() && !fs.lstatSync(p).isSymbolicLink());
assert.equal(hash(path.join(live, 'index.html')), expectedIndex, 'Another deployment changed the live index; stop');
assert(!fs.existsSync(path.join(release, 'deployment.json')), 'Rollout receipt already exists');
const prior = files(live), next = files(incoming);
assert(next.some(file => file.path === 'index.html'));
assert(next.length >= 100);
const originalManifest = JSON.parse(fs.readFileSync(path.join(root, 'evidence/teacher-unified-cutover-2026-10-15T05-51-36-036Z/manifest.json'), 'utf8'));
const sources = originalManifest.sources.map(file => ({ path: file.path, sha256: hash(path.join(root, file.path)) }));
assert.deepEqual(sources, originalManifest.sources, 'Installed backend differs from its established source receipt');
const configHash = hash(path.join(root, 'application-config.json'));
const backendPid = fs.readFileSync(path.join(root, 'host.pid'), 'utf8').trim();
assert(fs.existsSync('/proc/' + backendPid), 'Existing host must be running');
const backup = path.join(release, 'student-dist-before');
assert(!fs.existsSync(backup));
fs.cpSync(live, backup, { recursive: true, errorOnExist: true, force: false });
assert.deepEqual(files(backup), prior, 'Static backup must match every original file');
fs.writeFileSync(path.join(release, 'before.json'), JSON.stringify({ indexHash: expectedIndex, backendPid, staticFiles: prior, sources }, null, 2), { flag: 'wx', mode: 0o600 });
for (const file of next.filter(file => file.path !== 'index.html')) {
  const target = path.join(live, file.path);
  if (fs.existsSync(target)) assert.equal(hash(target), file.sha256, 'Existing asset path has different contents');
  else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(incoming, file.path), target, fs.constants.COPYFILE_EXCL); }
  assert.equal(hash(target), file.sha256);
}
assert.equal(hash(path.join(live, 'index.html')), expectedIndex, 'Concurrent index change detected before cutover');
const temporaryIndex = path.join(live, '.board-index-cffa6e6.tmp');
fs.copyFileSync(path.join(incoming, 'index.html'), temporaryIndex, fs.constants.COPYFILE_EXCL);
fs.renameSync(temporaryIndex, path.join(live, 'index.html'));
for (const file of next) assert.equal(hash(path.join(live, file.path)), file.sha256);
assert.equal(hash(path.join(root, 'application-config.json')), configHash);
assert.equal(fs.readFileSync(path.join(root, 'host.pid'), 'utf8').trim(), backendPid);
assert(fs.existsSync('/proc/' + backendPid));
assert.deepEqual(sources, originalManifest.sources.map(file => ({ path: file.path, sha256: hash(path.join(root, file.path)) })));
const receipt = { deployedAtUtc: new Date().toISOString(), sourceHead, scope: 'student static files only',
  previousIndexHash: expectedIndex, indexHash: hash(path.join(live, 'index.html')), backendPid,
  staticFiles: next, oldAssetsRetained: true, backendFilesVerifiedUnchanged: sources.length,
  configUnchanged: true, databaseTouched: false, privateStoresRead: false, rollbackIndex: path.join(backup, 'index.html') };
fs.writeFileSync(path.join(release, 'deployment.json'), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ ...receipt, staticFiles: receipt.staticFiles.length }));
