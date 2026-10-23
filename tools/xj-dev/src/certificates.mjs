import { execFileSync } from 'node:child_process';
import { createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from './envelope.mjs';
import { acquireLock } from './state.mjs';

export function opensslAvailable() {
  try {
    execFileSync('openssl', ['version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function openssl(args) {
  try {
    execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new CliError('certificates', 'CERTIFICATE_FAILED',
      `openssl ${args[0]} 失败：${String(error.stderr || error.message).trim()}`,
      { recovery: '确认 openssl 可用（macOS 自带；Windows 可使用 Git for Windows 附带的 openssl）。' });
  }
}

export function ensureCertificateAuthority(home) {
  const directory = join(home, 'ca');
  const keyFile = join(directory, 'ca-key.pem');
  const certFile = join(directory, 'ca-cert.pem');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = acquireCaLock(directory);
  try {
    const pending = join(directory, '.pending');
    const pendingKey = join(pending, 'ca-key.pem');
    const pendingCert = join(pending, 'ca-cert.pem');
    // Recheck only after acquiring the shared home guard. Environment locks
    // protect different roots and cannot serialize this shared trust anchor.
    if (existsSync(keyFile) && existsSync(certFile)) {
      if (!validAuthority(keyFile, certFile)) invalidAuthority('CA_INVALID');
      if (validAuthority(pendingKey, pendingCert) && readFileSync(pendingCert).equals(readFileSync(certFile))) {
        rmSync(pending, { recursive: true, force: true });
      }
      return { keyFile, certFile, created: false };
    }
    const partial = existsSync(keyFile) || existsSync(certFile);
    if (partial) {
      // A killed publisher may have linked only one file. Complete it solely
      // from its matching staged generation; never regenerate an existing root.
      const key = existsSync(keyFile) ? keyFile : pendingKey;
      const cert = existsSync(certFile) ? certFile : pendingCert;
      if (!validAuthority(key, cert)) invalidAuthority('CA_INCOMPLETE');
    } else if (!validAuthority(pendingKey, pendingCert)) {
      requireOpenssl();
      mkdirSync(pending, { recursive: true, mode: 0o700 });
      openssl(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', pendingKey, '-out', pendingCert,
        '-days', '3650', '-nodes', '-subj', '/CN=XunJie Local Development CA',
        '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
      chmodSync(pendingKey, 0o600);
      if (!validAuthority(pendingKey, pendingCert)) invalidAuthority('CA_INVALID');
    }
    // Atomic, no-replace publication. Keep the staged pair until both links
    // exist, so process death between links remains recoverable on Windows too.
    if (!existsSync(keyFile)) linkSync(pendingKey, keyFile);
    if (!existsSync(certFile)) linkSync(pendingCert, certFile);
    rmSync(pending, { recursive: true, force: true });
    return { keyFile, certFile, created: true };
  } finally { lock.release(); }
}

function acquireCaLock(directory) {
  const paths = { root: directory, lockFile: join(directory, 'initialization.lock') };
  const deadline = Date.now() + 15000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  // The public synchronous API is used during startup. Briefly wait for a
  // concurrent first up, then preserve the existing retryable LOCK_HELD result.
  while (true) {
    try { return acquireLock(paths); }
    catch (error) {
      if (error.code !== 'LOCK_HELD' || Date.now() >= deadline) throw error;
      Atomics.wait(wait, 0, 0, 25);
    }
  }
}

function invalidAuthority(code) {
  throw new CliError('certificates', code, '开发 CA 不完整、损坏或证书与密钥不匹配；已保留原有信任根。',
    { recovery: '保留 home/ca 与永久锁守卫，恢复同一 CA 的配对材料后重试；不要删除或重新生成已受信任的根证书。' });
}

function certificatePair(keyFile, certFile) {
  try {
    const cert = new X509Certificate(readFileSync(certFile));
    return cert.checkPrivateKey(createPrivateKey(readFileSync(keyFile))) ? cert : undefined;
  } catch { return undefined; }
}

function validAuthority(keyFile, certFile) {
  const cert = certificatePair(keyFile, certFile);
  return cert?.ca && cert.checkIssued(cert) && cert.verify(cert.publicKey) && currentlyValid(cert);
}

function currentlyValid(cert) {
  return Date.parse(cert.validFrom) <= Date.now() && Date.parse(cert.validTo) > Date.now();
}

function requireOpenssl() {
  if (!opensslAvailable()) {
    throw new CliError('certificates', 'OPENSSL_MISSING',
      '生成本地开发证书需要 openssl，但当前 PATH 中没有。',
      { recovery: 'macOS 自带 LibreSSL 可直接用；Windows 安装 Git for Windows 或 OpenSSL 后重试。' });
  }
}

export function ensureEnvironmentCertificate(envPaths, ca) {
  const keyFile = join(envPaths.tls, 'key.pem');
  const certFile = join(envPaths.tls, 'cert.pem');
  if (!validAuthority(ca.keyFile, ca.certFile)) invalidAuthority('CA_INVALID');
  const authority = new X509Certificate(readFileSync(ca.certFile));
  if (validLeaf(keyFile, certFile, authority)) return { keyFile, certFile, created: false };
  requireOpenssl();
  mkdirSync(envPaths.tls, { recursive: true, mode: 0o700 });
  // Callers hold the environment lock. Generate and verify a replacement before
  // touching the old leaf; an interrupted pair is repaired on the next up.
  const temporary = mkdtempSync(join(envPaths.tls, '.initialize-'));
  try {
    const stagedKey = join(temporary, 'key.pem');
    const stagedCert = join(temporary, 'cert.pem');
    const csrFile = join(temporary, 'request.csr');
    const extensionFile = join(temporary, 'extensions.txt');
    writeFileSync(extensionFile, 'subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
    openssl(['req', '-newkey', 'rsa:2048', '-keyout', stagedKey, '-out', csrFile, '-nodes', '-subj', '/CN=127.0.0.1']);
    openssl(['x509', '-req', '-in', csrFile, '-CA', ca.certFile, '-CAkey', ca.keyFile,
      '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-days', '825', '-out', stagedCert, '-extfile', extensionFile]);
    chmodSync(stagedKey, 0o600);
    if (!validLeaf(stagedKey, stagedCert, authority)) {
      throw new CliError('certificates', 'CERTIFICATE_FAILED', '新生成的环境证书未通过 CA、密钥或 HTTPS 用途校验。');
    }
    renameSync(stagedKey, keyFile);
    renameSync(stagedCert, certFile);
    return { keyFile, certFile, created: true };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

function validLeaf(keyFile, certFile, authority) {
  const cert = certificatePair(keyFile, certFile);
  return cert && !cert.ca && cert.checkIssued(authority) && cert.verify(authority.publicKey)
    && currentlyValid(cert)
    && cert.checkIP('127.0.0.1') && cert.checkHost('localhost', { subject: 'never' })
    && cert.keyUsage?.includes('1.3.6.1.5.5.7.3.1');
}

export function certificateTrustHint(home) {
  const certFile = join(home, 'ca', 'ca-cert.pem');
  if (process.platform === 'darwin') {
    return `信任本次开发 CA：security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "${certFile}"；按系统提示确认并核对证书指纹。浏览器须正常验证 HTTPS；精确信任/撤销步骤见 tools/xj-dev/README.md。`;
  }
  if (process.platform === 'win32') {
    return `信任本次开发 CA：${certFile}；在有 LocalMachine Root 写权限的 PowerShell 中用 .NET X509Store('Root','LocalMachine') 添加并按指纹读回（可能需管理员/UAC 确认）。CurrentUser Root 在部分主机不支持写入；具体脚本与精确撤销见 tools/xj-dev/README.md。浏览器须正常验证 HTTPS。`;
  }
  return `把本次开发 CA 加入系统或浏览器信任库并核对指纹：${certFile}；按系统要求确认权限，浏览器须正常验证 HTTPS。精确撤销见 tools/xj-dev/README.md。`;
}
