import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from './envelope.mjs';

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
  if (existsSync(keyFile) && existsSync(certFile)) return { keyFile, certFile, created: false };
  if (!opensslAvailable()) {
    throw new CliError('certificates', 'OPENSSL_MISSING',
      '生成本地开发证书需要 openssl，但当前 PATH 中没有。',
      { recovery: 'macOS 自带 LibreSSL 可直接用；Windows 安装 Git for Windows 或 OpenSSL 后重试。' });
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyFile, '-out', certFile,
    '-days', '3650', '-nodes', '-subj', '/CN=XunJie Local Development CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  return { keyFile, certFile, created: true };
}

export function ensureEnvironmentCertificate(envPaths, ca) {
  const keyFile = join(envPaths.tls, 'key.pem');
  const certFile = join(envPaths.tls, 'cert.pem');
  if (existsSync(keyFile) && existsSync(certFile)) return { keyFile, certFile, created: false };
  mkdirSync(envPaths.tls, { recursive: true });
  const csrFile = join(envPaths.tls, 'request.csr');
  const extensionFile = join(envPaths.tls, 'extensions.txt');
  writeFileSync(extensionFile, 'subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  openssl(['req', '-newkey', 'rsa:2048', '-keyout', keyFile, '-out', csrFile, '-nodes', '-subj', '/CN=127.0.0.1']);
  openssl(['x509', '-req', '-in', csrFile, '-CA', ca.certFile, '-CAkey', ca.keyFile,
    '-CAcreateserial', '-days', '825', '-out', certFile, '-extfile', extensionFile]);
  return { keyFile, certFile, created: true };
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
