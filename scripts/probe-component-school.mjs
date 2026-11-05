import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { release, version as osVersion } from 'node:os';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

// External consumer of a fixed product package. All credentials stay in the supplied private directory.
const mode = process.argv[2];
const base = resolve(process.env.XUNJIE_SCHOOL_PRIVATE);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const revision = process.env.XUNJIE_PRODUCTION_REVISION ?? '6171351171025bae457b9afbc1d33fc18ab5e481';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

if (mode === 'seed') {
  const pkg = resolve(process.env.XUNJIE_SCHOOL_PACKAGE);
  const root = resolve(process.env.XUNJIE_SCHOOL_ROOT);
  const runtime = await import(pathToFileURL(join(pkg, 'app/product-runtime.js')).href);
  const status = await json(join(root, 'status.json'));
  const endpoint = process.env.XUNJIE_SCHOOL_ENDPOINT ?? status.endpoint ?? status.environment.services[0].endpoint;
  const token = await runtime.resolveCredential(root, 'control');
  const api = async (route, body) => {
    const r = await fetch(endpoint + '/api/learning/' + route, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(r.status, 200, route + ': ' + r.status); return r.json();
  };
  const definition = await api('manage/component-import', { requestId: randomUUID(), ...await json(join(base, 'component-import.json')) });
  const definitionV3Input = await json(join(base, 'component-import.json'));
  definitionV3Input.manifest.version = 4;
  definitionV3Input.manifest.entry.resourceId = randomUUID();
  const nextDependencyId = randomUUID();
  definitionV3Input.manifest.dependencies[0].resourceId = nextDependencyId;
  definitionV3Input.dependencies[0].resourceId = nextDependencyId;
  const definitionV3 = await api('manage/component-import', { requestId: randomUUID(), ...definitionV3Input });
  const canonical = await api('manage/component-import', { requestId: randomUUID(), ...await json(join(base, 'canonical-component-import.json')) });
  const courseId = randomUUID(), taskId = randomUUID(), materialId = randomUUID();
  const text = '观察与解释\n\n阅读材料时，先区分观察到的事实与自己的解释。\n记录问题，再寻找可以核对的依据。\n\n再次核对时，先区分观察到的事实与新的解释。';
  const bytes = Buffer.from(text);
  const releases = [];
  for (const component of [definition, definitionV3, canonical]) {
    const releaseId = randomUUID();
    await api('manage/course-import', { formatVersion: 1, requestId: randomUUID(),
      course: { courseId, name: '跨机组件准备验收 179/181' }, task: { taskId, title: '阅读材料，记录理解', summary: '真实学校资源与准备报告' },
      release: { helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },  releaseId, objectives: ['核对事实'], requirements: '阅读并标注材料。', starterWorks: [], capabilities: [],
        components: [{ key: 'annotation', definition: component, configuration: { title: '材料标注' }, materialIds: [materialId] }],
        materials: [{ materialId, title: '阅读材料', path: 'material.txt', mediaType: 'text/plain', access: 'student', sha256: sha(bytes), byteLength: bytes.length }] },
      resources: [{ path: 'material.txt', contentBase64: bytes.toString('base64') }] });
    releases.push({ releaseId, definitionDigest: component.digest, version: component.manifest.version,
      entrySha256: component.manifest.entry.sha256, kind: component === canonical ? 'canonical-v3' : 'prepared' });
  }
  for (const actor of ['mac-web', 'mac-client', 'windows-web', 'windows-client']) {
    const loginName = 'wp03-' + actor, password = randomUUID();
    const member = await api('manage/members', { requestId: randomUUID(), loginName, password });
    await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true });
    await save(join(base, actor + '.json'), { revision, endpoint, actor, loginName, password, principalId: member.principalId,
      environmentId: status.environment.environmentId, courseId, releases, dependency: definition.manifest.dependencies[0], controlToken: token });
  }
  console.log('PASS isolated school seed: four separate members, prepared v2/v4 plus canonical v3 releases');
} else if (mode === 'browser') {
  const { chromium, expect } = await import(process.env.XUNJIE_PLAYWRIGHT_MODULE ?? '@playwright/test');
  const actor = process.env.XUNJIE_SCHOOL_ACTOR;
  const config = await json(join(base, actor + '.json'));
  const output = resolve(process.env.XUNJIE_SCHOOL_OUTPUT);
  await mkdir(output, { recursive: true });
  const report = { revision, actor, startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, osRelease: release(), osVersion: osVersion(),
    node: process.version, cases: [], status: 'running', traffic: [], failures: [],
    strictTLS: { ignoreHTTPSErrors: false, NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? 'default',
      caSha256: process.env.NODE_EXTRA_CA_CERTS ? sha(await readFile(process.env.NODE_EXTRA_CA_CERTS)) : null },
    launchOptions: { channel: 'chrome', headless: process.env.XUNJIE_SCHOOL_HEADLESS === '1' } };
  if (process.env.XUNJIE_SCHOOL_PACKAGE) {
    const pkg = resolve(process.env.XUNJIE_SCHOOL_PACKAGE);
    report.package = { directory: pkg, manifestSha256: sha(await readFile(join(pkg, 'distribution.json'))),
      provenance: await json(join(pkg, 'acceptance-provenance.json')).catch(() => ({ sourceRevision: revision, suppliedBy: 'fixed acceptance revision; original package manifest retained' })),
      applicationSha256: Object.fromEntries(await Promise.all(['cli.js', 'daemon.js', 'product-runtime.js'].map(async n => [n, sha(await readFile(join(pkg, 'app', n)))]))) };
  }
  let browser, runtime, context, page, endpoint = config.endpoint, connectionId;
  const pass = (name, detail) => { report.cases.push({ name, detail }); console.log('PASS ' + name); };
  const facts = p => p.evaluate(() => new Promise((done, reject) => {
    const q = indexedDB.open('xunjie-component-preparation-v1', 1);
    q.onupgradeneeded = () => {
      const db = q.result;
      db.createObjectStore('preparations', { keyPath: 'preparationId' }).createIndex('scope', 'scopeKey');
      db.createObjectStore('checks', { keyPath: 'fingerprint' });
      db.createObjectStore('resources', { keyPath: 'sha256' });
      db.createObjectStore('environments', { keyPath: 'scopeKey' });
    };
    q.onerror = () => reject(q.error);
    q.onsuccess = () => {
      const db = q.result;
      if (!db.objectStoreNames.contains('preparations')) { db.close(); done({ preparations: [], environments: [] }); return; }
      const tx = db.transaction(['preparations', 'environments'], 'readonly');
      const p = tx.objectStore('preparations').getAll(), e = tx.objectStore('environments').getAll();
      tx.oncomplete = () => { done({ preparations: p.result, environments: e.result }); db.close(); };
    };
  }));
  try {
    assert.equal(process.version, 'v24.21.0');
    browser = await chromium.launch({ channel: 'chrome', headless: process.env.XUNJIE_SCHOOL_HEADLESS === '1' });
    report.browser = browser.version(); report.headless = process.env.XUNJIE_SCHOOL_HEADLESS === '1';
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: false });
    const school = await browser.newContext({ ignoreHTTPSErrors: false });
    const login = await school.request.post(config.endpoint + '/api/learning/login', { data: { loginName: config.loginName, password: config.password } });
    assert.equal(login.status(), 200, 'strict HTTPS school login');
    pass('strict HTTPS school authentication without bypass');
    if (actor.endsWith('-client')) {
      const pkg = resolve(process.env.XUNJIE_SCHOOL_PACKAGE);
      const root = resolve(process.env.XUNJIE_SCHOOL_ROOT);
      const module = await import(pathToFileURL(join(pkg, 'app/product-runtime.js')).href);
      const resources = await json(join(pkg, 'resources.json'));
      for (const key of ['nodePath', 'postgresBin', 'webRoot', 'windowsPrerequisitePath']) if (resources[key]) resources[key] = resolve(pkg, resources[key]);
      runtime = module.openProductRuntime({ root, resources });
      await runtime.install({ profile: 'local' });
      const state = await runtime.start(); assert.equal(state.state, 'ready'); endpoint = state.endpoint;
      report.client = { profile: state.environment.profile, environmentId: state.environment.environmentId };
      const pendingResponse = await context.request.post(endpoint + '/api/learning/client/start', { data: { requestId: randomUUID(), schoolEndpoint: config.endpoint } });
      assert.equal(pendingResponse.status(), 200);
      const pending = await pendingResponse.json(); connectionId = pending.requestId;
      const approve = await school.newPage(); await approve.goto(pending.authorizationUrl, { waitUntil: 'domcontentloaded' });
      await approve.getByRole('button', { name: '允许连接', exact: true }).click();
      await expect(approve.getByText('连接已批准', { exact: false })).toBeVisible();
      const completed = await context.request.post(endpoint + '/api/learning/client/complete', { data: { requestId: connectionId } });
      assert.equal(completed.status(), 200); await approve.close();
      pass('installed client approved on real school page and completed its scoped connection');
    } else { await context.close(); context = school; }
    const api = async (route, body) => context.request[body === undefined ? 'get' : 'post'](endpoint + '/api/learning/' + route,
      { headers: connectionId ? { 'x-xj-space': 'school:' + connectionId } : {}, ...(body === undefined ? {} : { data: body }) });
    const admin = async (route, body) => {
      const r = await school.request.post(config.endpoint + '/api/learning/manage/' + route, { headers: { authorization: `Bearer ${config.controlToken}` }, data: body });
      assert.equal(r.status(), 200, 'admin ' + route); return r;
    };
    const scope = await api('context');
    // Context is a client-level route; scope is instead proven by the activity/report and durable browser keys below.
    report.contextRouteStatus = scope.status();
    const created = await api('course-activities', { requestId: randomUUID(), releaseId: config.releases[0].releaseId });
    assert.equal(created.status(), 200); const activity = await created.json();
    assert.equal(activity.identity.principalId, config.principalId);
    assert.equal(activity.identity.environmentId, config.environmentId);
    assert.equal(activity.course.releaseId, config.releases[0].releaseId);
    report.boundActivity = activity;
    const spaceKey = actor.endsWith('-client') ? 'school:' + connectionId : 'school';
    page = await context.newPage();
    page.on('pageerror', e => report.failures.push({ name: 'browser-pageerror', message: e.message }));
    page.on('requestfailed', r => report.traffic.push({ path: new URL(r.url()).pathname, failure: r.failure()?.errorText }));
    page.on('response', r => { if (/dependencies|preparation-report/.test(r.url())) report.traffic.push({ path: new URL(r.url()).pathname, status: r.status() }); });
    const url = endpoint + '?space=' + encodeURIComponent(spaceKey) + '&activity=' + activity.activityId;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: '材料标注', exact: true }).click();
    const frame = page.frameLocator('iframe[title="材料标注"]');
    await expect(frame.getByRole('button', { name: '标注选中文字' })).toBeEnabled({ timeout: 45000 });
    await expect.poll(async () => (await facts(page)).preparations[0]?.reportSubmitted, { timeout: 30000 }).toBe(true);
    const cold = await facts(page); assert.equal(cold.preparations[0].status, 'ready');
    assert.equal(cold.preparations[0].resourceBytes, config.dependency.byteLength);
    report.identity = cold.preparations[0].identity; report.scopeKey = cold.preparations[0].scopeKey;
    const persistedScope = JSON.parse(report.scopeKey);
    assert.deepEqual(persistedScope.slice(1, 4), [activity.identity.environmentId, activity.identity.spaceId, config.principalId]);
    assert.equal(persistedScope[5], 2);
    assert.equal(persistedScope[6], config.releases[0].definitionDigest);
    report.preparationId = cold.preparations[0].preparationId;
    pass('cold preparation downloads exact school dependency and submits production report', { resourceBytes: cold.preparations[0].resourceBytes });
    const route = `releases/${config.releases[0].releaseId}/components/annotation/`;
    const dependencyResponse = await api(route + 'dependencies/' + config.dependency.dependencyId);
    assert.equal(dependencyResponse.status(), 200);
    const dependencyBytes = await dependencyResponse.json();
    assert.equal(sha(Buffer.from(dependencyBytes.contentBase64, 'base64')), config.dependency.sha256);
    assert.equal(Buffer.from(dependencyBytes.contentBase64, 'base64').length, config.dependency.byteLength);
    pass('school dependency bytes match the immutable manifest SHA256 and byte length');
    const reportsR = await api(route + 'preparation-reports'); assert.equal(reportsR.status(), 200);
    const reports = await reportsR.json(); assert.ok(reports.length);
    assert.ok(reports.every(r => r.definitionDigest === config.releases[0].definitionDigest));
    report.preparationReports = reports;
    const direct = await school.request.get(config.endpoint + '/api/learning/' + route + 'preparation-reports');
    assert.equal(direct.status(), 200);
    // Other enrolled devices may submit between the two reads; verify this run's exact report.
    const ownReport = cold.preparations[0].reportPayload;
    assert.ok(reports.some(value => isDeepStrictEqual(value, ownReport)));
    assert.ok((await direct.json()).some(value => isDeepStrictEqual(value, ownReport)));
    pass('resource report is durably read back from Linux school for the bound release and principal');
    // Another real member is already enrolled; authentication changes within this same browser store.
    const other = await browser.newContext({ ignoreHTTPSErrors: false });
    const otherActor = await json(join(base, actor.startsWith('mac-') ? 'windows-web.json' : 'mac-web.json'));
    assert.equal((await other.request.post(config.endpoint + '/api/learning/login', { data: { loginName: otherActor.loginName, password: otherActor.password } })).status(), 200);
    const foreignActivity = await other.request.get(config.endpoint + '/api/learning/activities/' + activity.activityId);
    assert.ok([403, 404].includes(foreignActivity.status()), 'cross-principal activity must be refused');
    report.crossPrincipalStatus = foreignActivity.status();
    await other.close();
    pass('a different authenticated principal cannot read the original activity');
    report.expectedSubjectChecks = [];
    for (const [index, field] of ['environmentId', 'spaceId', 'principalId'].entries()) {
      const subject = [activity.identity.environmentId, activity.identity.spaceId, activity.identity.principalId];
      subject[index] = randomUUID();
      for (const suffix of ['dependencies/' + config.dependency.dependencyId, 'preparation-reports', 'preparation-report']) {
        const write = suffix === 'preparation-report';
        const r = await context.request[write ? 'post' : 'get'](endpoint + '/api/learning/' + route + suffix,
          { headers: { 'x-xj-space': spaceKey, 'x-xj-expected-subject': subject.join('.') },
            ...(write ? { data: { reportId: randomUUID(), requestId: randomUUID(), report: reports[0] } } : {}) });
        report.expectedSubjectChecks.push({ field, route: suffix, status: r.status(), freshReportIdentity: write });
        if (r.status() !== 403) report.failures.push({ name: 'product-expected-subject', message: suffix + ' accepted mismatched ' + field, status: r.status() });
      }
    }
    if (report.expectedSubjectChecks.every(item => item.status === 403)) pass('wrong environment, space and principal are refused for dependency, reports GET and fresh reports POST');
    const mismatchedRelease = await api(`releases/${config.releases[1].releaseId}/components/annotation/preparation-report`,
      { reportId: randomUUID(), requestId: randomUUID(), report: reports[0] });
    assert.equal(mismatchedRelease.status(), 400, 'report for another fixed component version must be refused');
    pass('a fresh report for v2 cannot be submitted against the v4 release');
    await page.screenshot({ path: join(output, actor + '-prepared.png'), fullPage: true });
    console.log('PHASE hot reload');
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByRole('tab', { name: '材料标注', exact: true }).click();
    await expect(frame.getByRole('button', { name: '标注选中文字' })).toBeEnabled({ timeout: 45000 });
    const hot = await facts(page); assert.equal(hot.preparations[0].preparationId, report.preparationId);
    assert.equal(hot.environments[0].environmentId, cold.environments[0].environmentId);
    pass('reload retains exact preparation and environment identity');
    // Fail the real dependency/report transport, then resume through the same durable browser store.
    console.log('PHASE dependency interruption');
    const retry = await browser.newContext({ ignoreHTTPSErrors: false });
    if (!actor.endsWith('-client')) await retry.addCookies((await context.storageState()).cookies);
    const interrupted = await retry.newPage();
    await interrupted.route('**/components/annotation/dependencies/**', route => route.abort('internetdisconnected'));
    await interrupted.goto(url, { waitUntil: 'domcontentloaded' }); await interrupted.getByRole('tab', { name: '材料标注', exact: true }).click();
    await expect.poll(async () => (await facts(interrupted)).preparations[0]?.status, { timeout: 30000 }).toBe('repairable');
    const failed = (await facts(interrupted)).preparations[0];
    await interrupted.screenshot({ path: join(output, actor + '-interrupted.png'), fullPage: true });
    await interrupted.unroute('**/components/annotation/dependencies/**');
    await interrupted.reload({ waitUntil: 'domcontentloaded' }); await interrupted.getByRole('tab', { name: '材料标注', exact: true }).click();
    await expect.poll(async () => (await facts(interrupted)).preparations[0]?.status, { timeout: 45000 }).toBe('ready');
    await expect(interrupted.frameLocator('iframe[title="材料标注"]').getByRole('button', { name: '标注选中文字' })).toBeEnabled({ timeout: 45000 });
    assert.equal((await facts(interrupted)).preparations[0].preparationId, failed.preparationId);
    await retry.close(); pass('dependency transport interruption recovers under original preparation identity');
    console.log('PHASE prepared v4');
    const v3Response = await api('course-activities', { requestId: randomUUID(), releaseId: config.releases[1].releaseId });
    assert.equal(v3Response.status(), 200); const v3 = await v3Response.json();
    await page.goto(endpoint + '?space=' + encodeURIComponent(spaceKey) + '&activity=' + v3.activityId, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: '材料标注', exact: true }).click();
    await expect.poll(async () => (await facts(page)).preparations.length, { timeout: 30000 }).toBe(2);
    await expect(frame.getByRole('button', { name: '标注选中文字' })).toBeEnabled({ timeout: 45000 });
    const versions = await facts(page);
    assert.equal(versions.preparations.find(p => p.preparationId === report.preparationId).status, 'ready');
    assert.notEqual(versions.preparations[0].preparationId, versions.preparations[1].preparationId);
    report.versionScopes = versions.preparations.map(p => ({ preparationId: p.preparationId, scopeKey: p.scopeKey }));
    pass('new component version uses a separate preparation without migrating the pinned release');
    console.log('PHASE canonical v3');
    const canonical = config.releases.find(r => r.kind === 'canonical-v3');
    const canonicalCreated = await api('course-activities', { requestId: randomUUID(), releaseId: canonical.releaseId });
    assert.equal(canonicalCreated.status(), 200); const canonicalActivity = await canonicalCreated.json();
    report.canonicalActivityId = canonicalActivity.activityId;
    const canonicalBundle = await api(`releases/${canonical.releaseId}/components/annotation`);
    assert.equal(canonicalBundle.status(), 200);
    const bundle = await canonicalBundle.json();
    assert.equal(bundle.definition.digest, canonical.definitionDigest);
    await page.goto(endpoint + '?space=' + encodeURIComponent(spaceKey) + '&activity=' + canonicalActivity.activityId, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: '材料标注', exact: true }).click();
    await expect(frame.getByRole('button', { name: '标注选中文字' })).toBeEnabled({ timeout: 45000 });
    await frame.locator('#materials p').click();
    await frame.locator('#materials p').evaluate(element => { const range = document.createRange(); range.selectNodeContents(element);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
    await frame.getByRole('button', { name: '标注选中文字' }).click();
    const note = '真实跨机 canonical v3 标注，重新打开仍是原作品。';
    const saveStarted = Date.now();
    await frame.getByRole('textbox', { name: '标注内容', exact: true }).fill(note);
    await expect.poll(async () => { const r = await api('workspaces/' + canonicalActivity.activityId);
      return JSON.parse((await r.json()).files[0]?.value ?? '{}').content?.annotations?.[0]?.note; }, { timeout: 60000 }).toBe(note);
    report.canonicalSchoolConfirmationMs = Date.now() - saveStarted;
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByRole('tab', { name: '材料标注', exact: true }).click();
    await expect(frame.getByRole('button', { name: '标注选中文字' })).toBeEnabled({ timeout: 45000 });
    await expect(frame.getByRole('textbox', { name: '标注内容', exact: true })).toHaveValue(note, { timeout: 30000 });
    await page.screenshot({ path: join(output, actor + '-canonical-v3.png'), fullPage: true });
    report.canonicalActivityId = canonicalActivity.activityId;
    pass('canonical annotationPackage v3 actual view writes to school and rereads the same annotation after reload');
    if (!connectionId) {
      await context.setOffline(true);
      try {
        const disconnected = await page.evaluate(async path => {
          try { const r = await fetch(path); return { status: r.status(), networkError: false }; }
          catch { return { status: null, networkError: true }; }
        }, '/api/learning/' + route + 'dependencies/' + config.dependency.dependencyId);
        assert.equal(disconnected.networkError, true);
        await expect(frame.getByRole('textbox', { name: '标注内容', exact: true })).toHaveValue(note);
        assert.equal((await facts(page)).preparations.find(p => p.preparationId === report.preparationId).scopeKey, report.scopeKey);
        report.chromeOffline = { method: 'BrowserContext.setOffline(true)', networkError: true, originalScopePreserved: true };
      } finally { await context.setOffline(false); }
      await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByRole('tab', { name: '材料标注', exact: true }).click();
      await expect(frame.getByRole('button', { name: '标注选中文字' })).toBeEnabled({ timeout: 45000 });
      await expect(frame.getByRole('textbox', { name: '标注内容', exact: true })).toHaveValue(note, { timeout: 30000 });
      pass('actual Chrome offline mode preserves original annotation and preparation scope and reloads after reconnect');
    }
    if (connectionId && process.env.XUNJIE_SCHOOL_NETWORK_HOOKS) {
      const hooks = await json(resolve(process.env.XUNJIE_SCHOOL_NETWORK_HOOKS));
      report.networkHooks = [];
      const runHook = name => {
        const started = Date.now();
        try {
          const output = execFileSync(hooks[name].file, hooks[name].args, { stdio: 'pipe', timeout: 90000, encoding: 'utf8' });
          let observation;
          try { observation = JSON.parse(output); } catch { observation = { result: 'command completed' }; }
          report.networkHooks.push({ action: name, status: 'passed', durationMs: Date.now() - started, observation });
        } catch (error) {
          let observation;
          try { observation = JSON.parse(String(error.stdout)); } catch { observation = { result: 'command failed', exitCode: error.status ?? null }; }
          report.networkHooks.push({ action: name, status: 'failed', durationMs: Date.now() - started, observation });
          throw new Error(`school ${name} hook failed (exit ${error.status ?? 'unknown'}); see networkHooks observation`);
        }
      };
      let originalFailure, recoveryFailure;
      try {
        runHook('stop');
        const blocked = await api(route + 'dependencies/' + config.dependency.dependencyId);
        assert.equal(blocked.status(), 503, 'independent Linux school process really stopped');
        await expect(frame.getByRole('textbox', { name: '标注内容', exact: true })).toHaveValue(note);
        assert.equal((await facts(page)).preparations.find(p => p.preparationId === report.preparationId).scopeKey, report.scopeKey);
        report.realDisconnect = { method: 'private stop/start execFile hooks for the independently hosted school instance', blockedStatus: 503, scopePreserved: true };
        await page.screenshot({ path: join(output, actor + '-school-stopped.png'), fullPage: true });
      } catch (error) {
        originalFailure = error;
        report.networkPrimaryFailure = { name: error.name, message: error.message };
      } finally {
        try { runHook('start'); } catch (error) {
          recoveryFailure = error;
          report.networkRecoveryFailure = { name: error.name, message: error.message };
        }
      }
      // Keep the failed disconnect assertion/stop as the primary cause even when restoration also fails.
      if (originalFailure) throw originalFailure;
      if (recoveryFailure) throw recoveryFailure;
      const recovered = await api('activities/' + canonicalActivity.activityId);
      assert.equal(recovered.status(), 200); assert.equal((await recovered.json()).activityId, canonicalActivity.activityId);
      await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByRole('tab', { name: '材料标注', exact: true }).click();
      await expect(frame.getByRole('button', { name: '标注选中文字' })).toBeEnabled({ timeout: 45000 });
      await expect(frame.getByRole('textbox', { name: '标注内容', exact: true })).toHaveValue(note, { timeout: 30000 });
      pass('stopping and restarting the real Linux school refuses access then recovers the same activity and annotation');
    }
    if (process.platform === 'win32' && connectionId && process.env.XUNJIE_SCHOOL_REAL_DISCONNECT === '1') {
      const netsh = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'netsh.exe');
      const ruleName = 'XunJie-WP03-isolated-' + randomUUID();
      const destination = new URL(config.endpoint);
      let ruleInstalled = false;
      try {
        execFileSync(netsh, ['advfirewall', 'firewall', 'add', 'rule', 'name=' + ruleName, 'dir=out', 'action=block',
          'program=' + process.execPath, 'remoteip=' + destination.hostname, 'protocol=TCP', 'remoteport=' + (destination.port || '443')], { windowsHide: true, stdio: 'pipe' });
        ruleInstalled = true;
        const blocked = await api(route + 'dependencies/' + config.dependency.dependencyId);
        assert.equal(blocked.status(), 503, 'actual program-scoped OS network block');
        const stillPersonal = await context.request.get(endpoint + '/api/learning/activities', { headers: { 'x-xj-space': 'personal' } });
        assert.equal(stillPersonal.status(), 200);
        assert.equal((await facts(page)).preparations.find(p => p.preparationId === report.preparationId).scopeKey, report.scopeKey);
        await page.screenshot({ path: join(output, actor + '-network-down.png'), fullPage: true });
        report.realDisconnect = { method: 'Windows outbound firewall rule scoped to the isolated package node.exe and school IP:443',
          blockedStatus: blocked.status(), personalStatus: stillPersonal.status(), scopePreserved: true };
      } finally {
        if (ruleInstalled) execFileSync(netsh, ['advfirewall', 'firewall', 'delete', 'rule', 'name=' + ruleName], { windowsHide: true, stdio: 'pipe' });
      }
      const recovered = await api('activities/' + canonicalActivity.activityId);
      assert.equal(recovered.status(), 200); assert.equal((await recovered.json()).activityId, canonicalActivity.activityId);
      await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByRole('tab', { name: '材料标注', exact: true }).click();
      await expect(frame.getByRole('button', { name: '标注选中文字' })).toBeEnabled({ timeout: 45000 });
      await expect(frame.getByRole('textbox', { name: '标注内容', exact: true })).toHaveValue(note, { timeout: 30000 });
      pass('actual Windows OS network block refuses school access, preserves personal access and resumes original activity without identity migration');
    }
    await admin('course-access', { requestId: randomUUID(), courseId: config.courseId, principalId: config.principalId, active: false });
    for (const suffix of ['dependencies/' + config.dependency.dependencyId, 'preparation-reports']) {
      const denied = await api(route + suffix); assert.equal(denied.status(), 403, suffix);
    }
    const revokedReport = await api(route + 'preparation-report', { reportId: randomUUID(), requestId: randomUUID(), report: reports[0] });
    assert.equal(revokedReport.status(), 403, 'revoked fresh report submission');
    pass('course qualification revocation denies dependency and report reads');
    await admin('course-access', { requestId: randomUUID(), courseId: config.courseId, principalId: config.principalId, active: true });
    if (connectionId) {
      await admin('connection', { connectionId });
      const denied = await api(route + 'dependencies/' + config.dependency.dependencyId); assert.equal(denied.status(), 403);
      const deniedReport = await api(route + 'preparation-report', { reportId: randomUUID(), requestId: randomUUID(), report: reports[0] });
      assert.equal(deniedReport.status(), 403, 'revoked connection fresh report submission');
      pass('school connection revocation closes installed client dependency forwarding');
    }
    report.status = report.failures.length ? 'failed' : 'passed';
    if (report.failures.length) process.exitCode = 1;
  } catch (error) {
    report.status = 'failed'; report.failures.push({ name: error.name, message: error.message });
    console.log('FAIL ' + error.name + ': ' + error.message.slice(0, 500)); process.exitCode = 1;
    await page?.screenshot({ path: join(output, actor + '-failure.png'), fullPage: true }).catch(() => {});
  } finally {
    await browser?.close(); if (runtime) await runtime.stop();
    report.finishedAt = new Date().toISOString();
    await save(join(output, actor + '-report.json'), report);
  }
} else if (mode === 'cleanup') {
  // Invoke only after all four actors finish; never stop the shared 8443 service.
  const output = resolve(process.env.XUNJIE_SCHOOL_OUTPUT);
  await mkdir(output, { recursive: true });
  const result = { status: 'running', operations: [], pending: [] };
  const hooks = await json(join(base, 'school-network-hooks.json'));
  try {
    execFileSync(hooks.stop.file, hooks.stop.args, { stdio: 'pipe', timeout: 60000 });
    result.operations.push('owned school-final instance stopped');
    const aliyun = process.env.XUNJIE_ALIYUN_CLI ?? '/opt/homebrew/bin/aliyun';
    const common = ['--RegionId', 'cn-beijing', '--SecurityGroupId', 'sg-2ze7b9txw6v48o8v2nf7'];
    const listed = JSON.parse(execFileSync(aliyun, ['ecs', 'DescribeSecurityGroupAttribute', ...common], { encoding: 'utf8', timeout: 60000 }));
    const descriptions = ['xunjie-wp03-179-181-isolated-temporary', 'xunjie-wp03-179-181-isolated-temporary-direct'];
    const owned = (listed.Permissions?.Permission ?? []).filter(r => descriptions.includes(r.Description)
      && r.PortRange === '443/443' && ['142.249.39.167/32', '101.94.133.245/32'].includes(r.SourceCidrIp));
    for (const rule of owned) {
      execFileSync(aliyun, ['ecs', 'RevokeSecurityGroup', ...common, '--SecurityGroupRuleId.1', rule.SecurityGroupRuleId], { stdio: 'pipe', timeout: 60000 });
    }
    result.operations.push(`removed ${owned.length} task-owned 443 /32 security-group rules`);
    const windows = '$ErrorActionPreference="Stop"; $thumb="82DF9D57437107A57557405678099B234BB7B223"; '
      + '$store=[Security.Cryptography.X509Certificates.X509Store]::new("Root","LocalMachine"); $store.Open("ReadWrite"); '
      + '$matches=@($store.Certificates | Where-Object Thumbprint -EQ $thumb); foreach($cert in $matches){$store.Remove($cert)}; '
      + '$store.Close(); "task CA removed: $($matches.Count)"';
    try {
      execFileSync('/usr/bin/ssh', ['-o', 'ConnectTimeout=6', 'win', windows], { stdio: 'pipe', timeout: 20000 });
      result.operations.push('task-added Windows LocalMachine CA removed by exact fingerprint');
    } catch { result.pending.push('Windows SSH unavailable: task-added LocalMachine CA removal remains unverified'); }
    result.status = result.pending.length ? 'partial' : 'completed';
  } catch (error) { result.status = 'failed'; result.pending.push(error.name + ': cleanup command failed; see private operator state'); process.exitCode = 1; }
  await save(join(output, 'cleanup-status.json'), result);
  console.log(JSON.stringify(result));
} else throw new Error('Use seed, browser or cleanup; supply XUNJIE_SCHOOL_PRIVATE and mode-specific paths.');
