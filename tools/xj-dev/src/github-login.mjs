import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CliError } from './envelope.mjs';
import { digest, ensurePrivateDirectory, opaque, privateJson, writePrivateJson } from './enrollment-protocol.mjs';
import { enrollmentTrust, enrollmentRequest, prepareEnrollment, joinEnrollment, readRegistration, refreshEnrollment } from './enrollment-client.mjs';
import { acquireLock } from './state.mjs';

const SCHEMA = 'xj-dev/github-login-state-v1';
const code = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const terminal = new Set(['GITHUB_NOT_APPROVED', 'GITHUB_AUTHORIZATION_DENIED', 'GITHUB_SESSION_EXPIRED', 'GITHUB_POLICY_CHANGED', 'GITHUB_SESSION_INVALID']);
function need(value, reason = 'GITHUB_LOGIN_INVALID') {
  if (!value) throw new CliError('enrollment', reason, `GitHub 接入未完成（${reason}）。`, {
    recovery: reason === 'GITHUB_SERVICE_CHANGED'
      ? '保留当前设备，用 refresh 核对原环境。确认迁移目标后，在独立 XJ_DEV_HOME 完成 GitHub 接入；不改写旧设备的信任或密钥。'
      : '保留同一工具 home；按当前授权状态继续 login。批准名单问题由维护者处理，不需要发送密码或 GitHub token。',
  });
}
export function readTeamService(file) {
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch { need(false, 'TEAM_SERVICE_REQUIRED'); }
  need(value?.schema === 'xj-dev/team-service-v1', 'TEAM_SERVICE_INVALID');
  let trust;
  try { trust = enrollmentTrust(value); } catch { need(false, 'TEAM_SERVICE_INVALID'); }
  need(typeof value.githubClientId === 'string' && /^[A-Za-z0-9]{10,64}$/.test(value.githubClientId), 'TEAM_SERVICE_INVALID');
  need(typeof value.applicationName === 'string' && value.applicationName.length > 0 && value.applicationName.length <= 128, 'TEAM_SERVICE_INVALID');
  return { serviceId: value.serviceId, applicationName: value.applicationName, githubClientId: value.githubClientId, trust };
}
function fingerprint(service) {
  return digest(JSON.stringify([service.serviceId, service.githubClientId, service.trust]));
}
function pendingResponse(state, service) {
  const start = state.authorization;
  need(start?.clientId === service.githubClientId, 'GITHUB_APPLICATION_CHANGED');
  need(start && id(start.sessionId) && code.test(start.userCode) && start.verificationUri === 'https://github.com/login/device'
    && Number.isSafeInteger(start.expiresAt) && Number.isInteger(start.intervalMs) && start.intervalMs >= 1000 && start.intervalMs <= 900000);
  return { state: 'authorization-required', applicationName: service.applicationName, verificationUri: start.verificationUri,
    userCode: start.userCode, expiresAt: start.expiresAt, retryAfterMs: Math.max(0, state.nextPollAt - Date.now()),
    next: ['在 GitHub 确认当前应用和短码，然后继续 login --wait-seconds 60；设备与账号由工具准备。'] };
}

// Only the user-facing short code and private-file paths cross this boundary.
// The session bearer stays in the protected home; OAuth tokens stay on ECS.
export async function githubLogin({ home, serviceFile, waitSeconds = 0 } = {}) {
  need(Number.isInteger(waitSeconds) && waitSeconds >= 0 && waitSeconds <= 60, 'GITHUB_WAIT_INVALID');
  const service = readTeamService(serviceFile), previous = readRegistration({ home });
  if (previous?.state === 'registered') need(previous.serviceId === service.serviceId, 'GITHUB_SERVICE_MISMATCH');
  const root = join(resolve(home), 'github-login', digest(service.serviceId).slice(0, 24));
  ensurePrivateDirectory(root);
  const file = join(root, 'state.json'), lock = acquireLock({ root, lockFile: join(root, 'operation-lock') });
  let state;
  try {
    state = existsSync(file) ? privateJson(file) : undefined;
    if (state) need(state.schema === SCHEMA && state.serviceDigest === fingerprint(service), 'GITHUB_SERVICE_CHANGED');
    if (previous?.state === 'registered') {
      const saved = privateJson(previous.deviceFile);
      need(JSON.stringify(saved.trust) === JSON.stringify(service.trust), 'GITHUB_SERVICE_CHANGED');
      const enrollment = await refreshEnrollment({ deviceFile: previous.deviceFile });
      writePrivateJson(file, { schema: SCHEMA, serviceDigest: fingerprint(service), deviceFile: enrollment.deviceFile });
      return { state: 'registered', reused: true, enrollment };
    }
    if (!state) {
      state = { schema: SCHEMA, serviceDigest: fingerprint(service), sessionSecret: opaque() };
      writePrivateJson(file, state); // A lost start reply must reuse the same request.
    }
    if (state.deviceFile) {
      const registered = await joinEnrollment({ deviceFile: state.deviceFile });
      state = { schema: SCHEMA, serviceDigest: fingerprint(service), deviceFile: registered.deviceFile };
      writePrivateJson(file, state);
      return { state: 'registered', enrollment: registered };
    }
    need(typeof state.sessionSecret === 'string' && /^[A-Za-z0-9_-]{32}$/.test(state.sessionSecret));
    if (state.authorization?.expiresAt <= Date.now() || terminal.has(state.failureCode)) {
      // Expired, unredeemed browser sessions carry no device identity. Starting
      // another one does not replace a prepared/registered enrollment above.
      state = { schema: SCHEMA, serviceDigest: fingerprint(service), sessionSecret: opaque() };
      writePrivateJson(file, state);
    }
    if (!state.authorization) {
      const start = await enrollmentRequest(service.trust, '/v1/github/start', { sessionSecret: state.sessionSecret });
      pendingResponse({ authorization: start, nextPollAt: Date.now() }, service);
      need(start.expiresAt > Date.now() && start.expiresAt <= Date.now() + 1800000);
      state.authorization = Object.fromEntries(['sessionId', 'userCode', 'verificationUri', 'expiresAt', 'intervalMs', 'clientId'].map(k => [k, start[k]]));
      state.nextPollAt = Date.now() + start.intervalMs;
      writePrivateJson(file, state);
      if (!waitSeconds) return pendingResponse(state, service);
    }
    const deadline = Date.now() + waitSeconds * 1000;
    do {
      const remaining = state.nextPollAt - Date.now();
      if (remaining > 0) {
        if (!waitSeconds || Date.now() + remaining > deadline) return pendingResponse(state, service);
        await delay(remaining);
      }
      const response = await enrollmentRequest(service.trust, '/v1/github/poll', {
        sessionId: state.authorization.sessionId, sessionSecret: state.sessionSecret,
      });
      if (response.state === 'authorized') {
        const invite = response.invitation;
        need(invite?.serviceId === service.serviceId && JSON.stringify(enrollmentTrust(invite)) === JSON.stringify(service.trust), 'GITHUB_SERVICE_CHANGED');
        need(response.github && /^[1-9][0-9]{0,19}$/.test(String(response.github.id)) && typeof response.github.login === 'string');
        const bytes = Buffer.from(JSON.stringify(invite));
        let prepared;
        try { prepared = prepareEnrollment({ home, invitationBytes: bytes }); }
        finally { bytes.fill(0); }
        state.deviceFile = prepared.deviceFile;
        writePrivateJson(file, state);
        const enrollment = await joinEnrollment({ deviceFile: prepared.deviceFile });
        state = { schema: SCHEMA, serviceDigest: fingerprint(service), deviceFile: enrollment.deviceFile };
        writePrivateJson(file, state);
        return { state: 'registered', github: { id: String(response.github.id), login: response.github.login }, enrollment };
      }
      need(response.state === 'pending' && Number.isSafeInteger(response.retryAfterMs) && response.retryAfterMs > 0
        && response.retryAfterMs <= 3600000 && response.expiresAt === state.authorization.expiresAt);
      state.nextPollAt = Date.now() + response.retryAfterMs;
      writePrivateJson(file, state);
    } while (waitSeconds && Date.now() < deadline);
    return pendingResponse(state, service);
  } catch (error) {
    if (state && !state.deviceFile && terminal.has(error?.code)) writePrivateJson(file, { ...state, failureCode: error.code });
    if (error instanceof CliError) throw error;
    need(false, 'GITHUB_LOGIN_STATE_INVALID');
  } finally { lock.release(); }
}
