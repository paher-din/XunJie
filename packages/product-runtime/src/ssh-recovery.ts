import cp from 'node:child_process';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { RecoveryError } from './recovery.js';
import type { RecoveryReceiver } from './recovery.js';

const remotePath = z.string().min(1).max(1000).startsWith('/').regex(/^[^\x00-\x1f\x7f]+$/);
export const sshReceiverSchema = z.object({ id: z.string().regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/i), ssh: z.object({
  configFile: z.string().refine(isAbsolute), host: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/),
  nodePath: remotePath, cliPath: remotePath, root: remotePath,
}).strict() }).strict();
export type SshRecoveryReceiver = z.infer<typeof sshReceiverSchema>;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Deployment SSH performs maintenance only; student traffic still uses direct authenticated HTTPS. */
export function createSshRecoveryReceiver(value: SshRecoveryReceiver): RecoveryReceiver {
  const receiver = sshReceiverSchema.parse(value);
  return { id: receiver.id, async fence(source, serviceIds, binding) {
    const backupId = z.uuid().parse(binding.backupId);
    const targetInstallationId = z.uuid().parse(binding.targetInstallationId);
    const ids = z.array(z.uuid()).min(1).max(100).parse([...serviceIds]);
    const environmentId = z.uuid().parse(source.environmentId);
    // The retired installation is fenced by identity, so a successor installation of the same
    // environment and service remains authorized at the receiving authority.
    const installationId = z.uuid().parse(source.installationId);
    const payload = JSON.stringify({ expectedReceiver: receiver.id, sourceEnvironmentId: environmentId,
      sourceInstallationId: installationId, sourceServiceIds: ids, backupId, targetInstallationId });
    // Windows OpenSSH never signals channel EOF for the local stdin it forwards, so piping the
    // request into the remote `/dev/stdin` hangs the takeover. Carry the identity-only request as
    // base64 in the command and decode it through a remote-local pipeline instead; the receiving
    // POSIX shell then supplies a clean EOF to the CLI on every supported deployment host.
    const encoded = Buffer.from(payload, 'utf8').toString('base64');
    const cli = [receiver.ssh.nodePath, receiver.ssh.cliPath, 'fence-source', '--root', receiver.ssh.root,
      '--file', '/dev/stdin'].map(quote).join(' ');
    const command = `printf '%s' '${encoded}' | base64 --decode | ${cli}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: (value: unknown) => void, value: unknown) => { if (!settled) { settled = true; fn(value); } };
      const fail = () => finish(reject, new RecoveryError('receiver-unavailable'));
      let output = '';
      const readProof = () => {
        const proof = z.object({ fenced: z.literal(true), receiverId: z.literal(receiver.id), sourceEnvironmentId: z.literal(environmentId),
          backupId: z.literal(backupId), targetInstallationId: z.literal(targetInstallationId),
          sourceInstallationId: z.literal(installationId), sourceServiceIds: z.array(z.uuid()),
          execution: z.object({ formatVersion: z.literal(1), boundaryAt: z.iso.datetime(),
            unresolved: z.literal(0), blocking: z.literal(0), services: z.array(z.object({ serviceId: z.uuid(),
              unresolved: z.literal(0), settled: z.number().int().nonnegative(), blocking: z.literal(0) }).strict()).min(1) }).strict(),
        }).strict().parse(JSON.parse(output));
        if (JSON.stringify(proof.sourceServiceIds) !== JSON.stringify(ids)) throw new Error();
        return proof;
      };
      const child = cp.spawn('ssh', ['-F', receiver.ssh.configFile, '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'ForwardAgent=no', '-o', 'ConnectTimeout=10', receiver.ssh.host, command],
      { shell: false, windowsHide: true, timeout: 90000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (!child.stdout) { fail(); return; }
      child.stdout.on('data', (bytes: Buffer) => {
        output += bytes.toString('utf8');
        if (Buffer.byteLength(output) > 65536) { child.kill(); fail(); return; }
        // Windows OpenSSH can deliver the proof yet never close the channel. The identity-bound
        // proof is the confirmation, so accept it as soon as the complete line arrives.
        if (output.endsWith('\n')) {
          try { const proof = readProof(); child.kill(); finish(resolve, proof); } catch { /* incomplete or invalid; await close */ }
        }
      });
      child.on('error', fail);
      child.on('close', code => {
        if (settled) return;
        if (code !== 0) { fail(); return; }
        try { finish(resolve, readProof()); } catch { finish(reject, new RecoveryError('invalid-receiver-proof')); }
      });
    });
  } };
}
