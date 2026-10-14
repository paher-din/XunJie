import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const root = '/opt/xunjie-ui-local';
const source = `${root}/source/apps/teaching`;
if (process.platform !== 'linux' || process.version !== 'v24.21.0') throw new Error('Prepared local Linux Node24.21.0 required');
const nodeReceipt = '/opt/xunjie-runner/local-node-ready.json';
if (!existsSync(nodeReceipt)) throw new Error('Current local node receipt is missing');
for (const name of ['initializer.json', 'application-config.json', 'signing-secret.txt']) if (existsSync(`${root}/${name}`)) throw new Error('Local application already prepared; inspect instead of overwriting');
const load = path => import(pathToFileURL(`${source}/${path}`).href);
const { executionTransports } = await load('server/app/execution-transport.ts');
const { availableRuntime } = await load('server/design/readiness.ts');
const { availableHdlRuntime } = await load('server/design/hdl-configurations.ts');
const { initializeSyntheticApplication } = await load('server/app/initialize.ts');
const { sshConfigurationSchema } = await load('server/app/config.ts');
const saved = JSON.parse(readFileSync(nodeReceipt, 'utf8'));
const ssh = sshConfigurationSchema.parse(saved.ssh);
if (ssh.host !== '127.0.0.1' || ssh.port !== 2222 || ssh.keyFile !== '/opt/xunjie-runner/vm/keys/application') throw new Error('Owned local execution endpoint required');
const transport = executionTransports(ssh);
const runner = await transport.runner({ op: 'readiness' });
const hdl = await transport.hdlTransport({ op: 'hdl_readiness' });
const c = await availableRuntime(async () => runner);
if (!c || !hdl?.data?.profile || !hdl.data.ready || hdl.data.profile.sourceHash !== '7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852') throw new Error('Actual frozen local C/HDL readiness required');
const approvedHdlRuntime = hdl.data.profile;
const current = await availableHdlRuntime(async () => hdl, [approvedHdlRuntime]);
if (c.recoveryGeneration !== current.recoveryGeneration) throw new Error('Local execution generations differ');
const recoveryGeneration = c.recoveryGeneration;
const accounts = ['teacher', 'student-a', 'student-b'].map(name => ({ id: `synthetic-robert-${name}`, loginName: `synthetic-robert-${name}`, password: randomBytes(24).toString('base64url') }));
const courses = ['synthetic-robert-course-c', 'synthetic-robert-course-hdl'];
const memberships = courses.flatMap(courseId => accounts.map(account => ({ courseId, userId: account.id, role: account.id === 'synthetic-robert-teacher' ? 'teacher' : 'student' })));
const manifest = { synthetic: true, recoveryGeneration, accounts, courses, memberships };
mkdirSync(`${root}/evidence`, { recursive: true, mode: 0o700 });
mkdirSync(`${root}/retained-tmp`, { recursive: true, mode: 0o700 });
process.env.TMPDIR = `${root}/retained-tmp`;
const db = await initializeSyntheticApplication(manifest, transport, [approvedHdlRuntime]);
try {
  const config = { databaseFile: db.file, origin: 'https://127.0.0.1:3444',
    tls: { keyFile: `${root}/tls/server.key.pem`, certFile: `${root}/tls/server.crt.pem` },
    signingSecretFile: `${root}/signing-secret.txt`, ssh, approvedHdlRuntimes: [approvedHdlRuntime], recoveryGeneration,
    staticDirectory: `${root}/student-dist`, consumerIntervalMs: 250,
    tutoring: { callsAuthorized: false, versions: { modelConfig: 'deepseek-flash-v1', prompt: 'student-help-v1', schema: 'student-help-v1', policy: 'activity-policy' } },
  };
  writeFileSync(`${root}/signing-secret.txt`, randomBytes(32).toString('base64url') + '\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(`${root}/initializer.json`, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
  writeFileSync(`${root}/application-config.json`, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
  // Publish the local receipt only after the original factory has succeeded.
  // A failed factory can then be retried without leaving a false completed receipt.
  writeFileSync(`${root}/local-readiness.json`, JSON.stringify({ recoveryGeneration, runner, hdl, approvedHdlRuntime, ssh }, null, 2), { flag: 'wx', mode: 0o600 });
  writeFileSync(`${root}/course-seed-config.json`, JSON.stringify({ applicationConfigFile: `${root}/application-config.json`, initializerFile: `${root}/initializer.json`, readinessFile: `${root}/local-readiness.json` }), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ initialized: true, databaseFile: db.file, recoveryGeneration, accountCount: 3, courseCount: 2, origin: config.origin, modelCallsAuthorizedByDefault: false }));
} finally { db.close(); }
