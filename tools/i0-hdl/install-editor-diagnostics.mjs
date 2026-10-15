import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

// Run only after approval of the VM's exact application forced-command change.
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
const [staging, configPath, mode] = process.argv.slice(2);
assert(staging?.startsWith('/opt/xunjie-runner/tests/') && configPath?.startsWith('/opt/xunjie-runner/') && configPath.endsWith('.json'));
assert(['prepare', 'apply'].includes(mode));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const destination = '/opt/xunjie-runner/editor-diagnostics-20261015-v1';
const socketUnit = 'xunjie-editor-20261015.socket', serviceUnit = 'xunjie-editor-20261015.service';
const socket = '/run/xunjie-editor/control.sock';
for (const value of [config.node, configPath, destination]) assert(/^\/[A-Za-z0-9/_.-]+$/.test(value));
const files = ['editor-diagnostics.ts', 'editor-diagnostics-service.ts', 'editor-diagnostics-entry.ts', 'docker.ts', 'snapshot.ts', 'node-files.ts'];
const sha = value => createHash('sha256').update(value).digest('hex');
const publicFiles = Object.fromEntries(files.map(name => [name, fs.readFileSync(path.join(staging, 'runner', name))]));
const authorizedPath = '/root/.ssh/authorized_keys', original = fs.readFileSync(authorizedPath, 'utf8');
const lines = original.split('\n');
const candidates = lines.map((line, index) => ({ index, command: line.match(/(?:^|,)command="([^"]+)"/)?.[1] }))
  .filter(item => item.command?.startsWith(config.node + ' /opt/xunjie-runner/') && item.command.endsWith('/runner/ssh-control.ts'));
assert.equal(candidates.length, 1, 'Exactly one original application forced command required');
const selected = candidates[0];
const originalEntry = selected.command.slice(config.node.length + 1);
assert(/^\/[A-Za-z0-9/_.-]+$/.test(originalEntry) && fs.statSync(originalEntry).isFile());
assert(/^ ssh-|^ ecdsa-/.test(' ' + lines[selected.index].split(' ').slice(-2).join(' ')) || lines[selected.index].includes('ssh-ed25519 '));
const nextCommand = `${config.node} ${destination}/editor-diagnostics-entry.ts ${socket} ${originalEntry}`;
lines[selected.index] = lines[selected.index].replace(`command="${selected.command}"`, `command="${nextCommand}"`);
const next = lines.join('\n');
const unitFiles = {
  [socketUnit]: `[Unit]\nDescription=XunJie private editor diagnostic socket\n[Socket]\nListenStream=${socket}\nSocketMode=0600\nDirectoryMode=0700\n[Install]\nWantedBy=sockets.target\n`,
  [serviceUnit]: `[Unit]\nDescription=XunJie isolated editor diagnostics\nRequires=${socketUnit}\nAfter=${socketUnit}\n[Service]\nType=simple\nExecStart=${config.node} ${destination}/editor-diagnostics-service.ts ${configPath} ${socket}\nUser=root\nGroup=root\nUMask=0077\nNoNewPrivileges=true\nProtectHome=true\nProtectSystem=strict\nPrivateTmp=true\nMemoryMax=256M\nTasksMax=64\nRestart=on-failure\n`,
};
const proposal = { applicationEntryOnly: true, originalCommand: selected.command, nextCommand,
  originalAuthorizationHash: sha(original), nextAuthorizationHash: sha(next),
  files: Object.fromEntries(Object.entries(publicFiles).map(([name, bytes]) => [name, sha(bytes)])),
  units: Object.keys(unitFiles), preservesOriginalEngineSource: config.source };
if (mode === 'prepare') { console.log(JSON.stringify(proposal)); process.exit(0); }
for (const [name, text] of Object.entries(unitFiles)) {
  const target = '/etc/systemd/system/' + name;
  if (fs.existsSync(target)) assert.equal(fs.readFileSync(target, 'utf8'), text, 'Existing service is different');
}
fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
for (const [name, bytes] of Object.entries(publicFiles)) {
  const target = path.join(destination, name);
  if (fs.existsSync(target)) assert.equal(sha(fs.readFileSync(target)), sha(bytes), 'Existing diagnostic version differs');
  else fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
}
for (const [name, text] of Object.entries(unitFiles)) {
  const target = '/etc/systemd/system/' + name;
  if (!fs.existsSync(target)) fs.writeFileSync(target, text, { flag: 'wx', mode: 0o644 });
}
execFileSync('/usr/bin/systemctl', ['daemon-reload']);
execFileSync('/usr/bin/systemctl', ['enable', '--now', socketUnit]);
assert.equal(fs.readFileSync(authorizedPath, 'utf8'), original, 'Authorization changed concurrently');
const backup = authorizedPath + '.before-editor-' + Date.now();
fs.writeFileSync(backup, original, { flag: 'wx', mode: 0o600 });
const pending = authorizedPath + '.editor-pending-' + Date.now();
fs.writeFileSync(pending, next, { flag: 'wx', mode: 0o600 });
fs.renameSync(pending, authorizedPath);
console.log(JSON.stringify({ ...proposal, authorizationBackup: backup, applied: true }));
