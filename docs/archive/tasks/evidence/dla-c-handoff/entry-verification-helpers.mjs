// Helpers for the two authorized development verifiers, not application APIs.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const failure = code => Object.assign(new Error('Development verification boundary failed'), {code});

export function exchangeHttps(request, options, body, validateResponse, timeoutMs) {
  return new Promise((resolve, reject) => {
    let req, settled = false;
    const fail = error => {
      if (settled) return;
      settled = true; reject(error); req?.destroy();
    };
    try {
      req = request(options, res => {
        let ended = false;
        const chunks = [];
        res.on('error', fail);
        res.once('aborted', () => fail(failure('RESPONSE_ABORTED')));
        res.once('close', () => {if (!ended) fail(failure('RESPONSE_CLOSED'));});
        res.on('data', chunk => {try {chunks.push(Buffer.from(chunk));} catch (error) {fail(error);}});
        res.once('end', () => {
          ended = true;
          if (settled) return;
          try {
            const response = {status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks).toString('utf8')};
            settled = true; resolve(response);
          } catch (error) {fail(error);}
        });
        try {validateResponse(res);} catch (error) {fail(error);}
      });
      req.on('error', fail);
      req.setTimeout(timeoutMs, () => fail(failure('REQUEST_DEADLINE')));
      req.end(body);
    } catch (error) {fail(error);}
  });
}

export function monitorApplication(child, log) {
  let failed, spawnFailed = false, rejectFailure;
  const pendingFailure = new Promise((resolve, reject) => {rejectFailure = reject;});
  const listeners = [];
  const watch = (emitter, code) => {
    const listener = () => {
      if (emitter === child && child.pid === undefined) spawnFailed = true;
      if (!failed) {failed = failure(code); rejectFailure(failed);}
    };
    emitter.on('error', listener); listeners.push([emitter, listener]);
  };
  watch(child, 'SERVER_PROCESS_ERROR'); watch(log, 'SERVER_LOG_ERROR');
  watch(child.stdout, 'SERVER_OUTPUT_ERROR'); watch(child.stderr, 'SERVER_OUTPUT_ERROR');
  return {
    get spawnFailed() {return spawnFailed;},
    get failureCode() {return failed?.code;},
    assertHealthy() {if (failed) throw failed;},
    run(work) {return Promise.race([Promise.resolve().then(work), pendingFailure]);},
    dispose() {for (const [emitter, listener] of listeners) emitter.removeListener('error', listener);},
  };
}

async function finishLog(log) {
  if (log.writableFinished) return;
  if (log.destroyed) throw failure('SERVER_LOG_ERROR');
  await new Promise((resolve, reject) => {
    const cleanup = () => {log.removeListener('error', onError);log.removeListener('close', onClose);};
    const onError = () => {cleanup();reject(failure('SERVER_LOG_ERROR'));};
    const onClose = () => {if (!log.writableFinished) onError();};
    log.once('error', onError);log.once('close', onClose);
    try {log.end(error => {cleanup();error ? reject(failure('SERVER_LOG_ERROR')) : resolve();});}
    catch {onError();}
  });
}

export async function stopApplication(child, log, {timeoutMs = 180000, spawnFailed = false} = {}) {
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  let stopErrorCode;
  const stopped = hasExited() || (!spawnFailed && await new Promise(resolve => {
    const finish = confirmed => {clearTimeout(timer);child.removeListener('exit', onExit);resolve(confirmed);};
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    // Only the original application child is signalled. Never force-kill a node.
    try {if (hasExited()) finish(true);else if (!child.kill('SIGTERM')) stopErrorCode='STOP_SIGNAL_UNCONFIRMED';}
    catch {stopErrorCode='STOP_SIGNAL_FAILED';}
  }));
  try {await finishLog(log);} catch {stopErrorCode ??= 'SERVER_LOG_ERROR';}
  const confirmed = Boolean(stopped || hasExited());
  return {serverPid: child.pid ?? null, serviceState: confirmed ? 'stopped' : spawnFailed ? 'not_started' : 'unknown',
    serviceRunning: confirmed || spawnFailed ? false : null, stopConfirmed: confirmed,
    serverExitCode: child.exitCode, serverSignalCode: child.signalCode,
    ...(stopErrorCode ? {shutdownErrorCode: stopErrorCode} : {})};
}

export function assertReleasedActivity(activity, expected) {
  assert.equal(activity.activityVersionId, expected.activityVersionId);
  assert.equal(activity.courseId, expected.courseId);
  assert.equal(activity.sourceRevision, expected.sourceRevision);
  assert.equal(activity.activityControlRevision, expected.activityControlRevision);
  assert.equal(activity.status, 'active');
  assert.equal(activity.runtimeProfileVersionId, expected.runtimeProfileVersionId);
  assert.equal(activity.helpPolicy.versionId, expected.helpPolicyVersionId);
  assert.equal(activity.helpPolicy.helpAllowed, true);
  assert.equal(activity.helpPolicy.wholeSolutionAllowed, false);
  assert.equal(activity.helpPolicy.limitedCheckHelpAllowed, false);
  assert.equal(activity.content.audience, expected.audience);
  assert.equal(activity.content.materials.length, 2);
  const [publicMaterial, privateMaterial] = activity.content.materials;
  assert.equal(publicMaterial.status, 'available');
  assert.equal(publicMaterial.resourceVersionId, expected.publicResourceId);
  assert.equal(publicMaterial.title, expected.publicMaterial.title);
  assert.equal(publicMaterial.text, expected.publicMaterial.text);
  assert.equal(publicMaterial.contentHash, expected.publicMaterial.contentHash);
  assert.equal(publicMaterial.contentHash, createHash('sha256').update(publicMaterial.text, 'utf8').digest('hex'));
  assert.deepEqual(privateMaterial, {status: 'redacted'});
}

export function assertFrozenActivity(activity, expected) {
  assert.equal(activity.activityVersionId, expected.activityVersionId);
  assert.equal(activity.courseId, expected.courseId);
  assert.equal(activity.sourceBlueprintId, expected.blueprintId);
  assert.equal(activity.sourceRevision, expected.blueprintRevision);
  assert.equal(activity.recoveryGeneration, expected.generation);
  assert.equal(activity.runtimeProfile.runtimeProfileVersion, expected.preparation.runtimeProfileVersion);
  for (const field of ['sourceHash', 'fingerprintHash', 'validatedAt']) {
    assert.equal(activity.runtimeReadiness[field], expected.preparation[field]);
  }
  const checked = Date.parse(activity.runtimeReadiness.checkedAt);
  assert(Number.isFinite(checked));
  assert(checked >= Date.parse(expected.preparation.checkedAt));
  assert(checked >= Date.parse(activity.runtimeReadiness.validatedAt));
  assert(checked <= Date.now());
}
