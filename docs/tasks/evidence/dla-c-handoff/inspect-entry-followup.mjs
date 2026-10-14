import assert from 'node:assert/strict';
import {readFileSync, statSync, existsSync} from 'node:fs';
import {hostname} from 'node:os';
import {X509Certificate, createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import net from 'node:net';

const source = '/opt/xunjie-runner/tests/i0-entry-source-9fa76ad-lf2-20261013/apps/teaching';
const root = '/opt/xunjie-runner/tests/i0-entry-20261013-01';
const handoff = '/opt/xunjie-runner/tests/i0-c-revalidation-cde69cc-20261013/handoff';
assert.equal(process.version, 'v24.21.0');
assert.equal(process.getuid(), 0);
const config = JSON.parse(readFileSync(root + (process.argv[2] === '--recovery-run' ? '/i0-host-recovered-20261014.json' : '/i0-host.json'), 'utf8'));
const {sshRunner} = await import(source + '/dist/server/records/runner.js');
const transport = sshRunner(JSON.parse(readFileSync(handoff + '/connection.json', 'utf8')));
const cert = new X509Certificate(readFileSync(config.tls.certFile));
const metadata = path => {
  const value = statSync(path);
  return {path, uid: value.uid, mode: (value.mode & 0o777).toString(8), bytes: value.size};
};
const listening = await new Promise(resolve => {
  const socket = net.connect({host: '127.0.0.1', port: 3443});
  socket.setTimeout(1500);
  socket.once('connect', () => {socket.destroy(); resolve(true);});
  socket.once('error', () => {socket.destroy(); resolve(false);});
  socket.once('timeout', () => {socket.destroy(); resolve(false);});
});
const readiness = {};
for (const op of ['readiness', 'hdl_readiness']) {
  try {readiness[op] = await transport({op});}
  catch {readiness[op] = {error: {code: 'DEPENDENCY_UNAVAILABLE'}};}
}
const Database = (await import(source + '/node_modules/better-sqlite3/lib/index.js')).default;
let database = {path: config.databaseFile, exists: existsSync(config.databaseFile), opened: false};
if (database.exists) {
 const db = new Database(config.databaseFile, {readonly: true, fileMustExist: true});
 try {
  database = {...database, opened: true,
    tables: db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().count,
    assignment: db.prepare('SELECT id,assignment_revision,status FROM assignments WHERE id=?').get('9906a7af-a43e-44da-a395-db8491c4cbbf'),
    runJobStates: db.prepare("SELECT status,count(*) AS count FROM jobs WHERE json_extract(job_json,'$.purpose')='student_run' GROUP BY status").all()};
 } finally {db.close();}
}
const linuxBrowsers = ['google-chrome', 'chromium', 'firefox'].map(binary => {
  try {return {binary, path: execFileSync('/usr/bin/which', [binary], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim()};}
  catch {return {binary, path: null};}
});
console.log(JSON.stringify({checkedAt: new Date().toISOString(), host: hostname(), uid: process.getuid(), node: process.version,
  sourceCommit: '9fa76adbfb37a60cc087f8bf2fbdd1e05cd18e77', origin: config.origin, listening,
  files: ['server.key.pem', 'server.cert.pem', 'signing-secret.txt', 'initializer.json', 'i0-host.json'].map(name => metadata(root + '/' + name)),
  certificate: {fingerprint256: cert.fingerprint256, validFrom: cert.validFrom, validTo: cert.validTo, subjectAltName: cert.subjectAltName,
    publicDerSha256: createHash('sha256').update(cert.raw).digest('hex')},
  database, linuxBrowsers, readiness,
  scope: 'Read-only metadata, original authenticated readiness and retained SQLite. No start, initialization, secret output or node maintenance.'}, null, 2));
