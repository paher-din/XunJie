import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DockerExecutor } from './docker.ts';
import { RunnerError, validateSnapshot } from './snapshot.ts';
import type { SnapshotFile } from './snapshot.ts';
import type { EditorDiagnostic, EditorDiagnosticsPacket, EditorDiagnosticsResult } from '../contracts/workspace/editor-diagnostics.ts';

function location(files: SnapshotFile[], path: unknown, line: unknown) {
  const file = files.find(file => '/snapshot/' + file.path === path);
  const text = file && Number.isSafeInteger(line) && Number(line) > 0 ? file.text.split('\n')[Number(line) - 1] : undefined;
  return { file, text: text?.replace(/\r$/, ''), line: text === undefined ? undefined : Number(line) };
}
function column(text: string, byte: unknown, ignoredBom: boolean): number | undefined {
  if (!Number.isSafeInteger(byte) || Number(byte) < 1) return;
  // GCC consumes a file's UTF-8 BOM before numbering bytes; the authoritative source still includes it.
  const bytes = Buffer.from(text), offset = Number(byte) - 1 + (ignoredBom ? 3 : 0);
  if (offset > bytes.length || offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) return;
  return bytes.subarray(0, offset).toString('utf8').length + 1;
}
export function parseCompilerDiagnostics(language: 'c' | 'hdl', output: string, files: SnapshotFile[]): EditorDiagnostic[] {
  const result: EditorDiagnostic[] = [];
  const append = (message: unknown, severity: unknown, path?: unknown, line?: unknown, caret?: unknown, finish?: unknown) => {
    if (typeof message !== 'string' || !message.trim() || result.length >= 100) return;
    const target = location(files, path, line);
    const item: EditorDiagnostic = { message: message.slice(0, 4000),
      severity: severity === 'warning' ? 'warning' : severity === 'note' ? 'info' : 'error' };
    if (target.file) {
      Object.assign(item, { fileId: target.file.fileId, path: target.file.path, contentHash: target.file.contentHash });
      if (target.line !== undefined) item.line = target.line;
      if (target.text !== undefined && target.line !== undefined) {
        const bom = target.line === 1 && target.text.startsWith('\ufeff');
        const start = column(target.text, caret, bom), last = column(target.text, finish ?? caret, bom);
        if (start !== undefined && last !== undefined && last >= start && last <= target.text.length) {
          const width = (target.text.codePointAt(last - 1) ?? 0) > 0xffff ? 2 : 1;
          item.range = { startLine: target.line, startColumn: start, endLine: target.line, endColumn: last + width };
        }
      }
    }
    result.push(item);
  };
  if (language === 'c') {
    const visit = (items: unknown) => {
      if (!Array.isArray(items)) throw new RunnerError('DEPENDENCY_UNAVAILABLE', 'Compiler diagnostics are not JSON');
      for (const item of items) {
        const at = item?.locations?.[0], caret = at?.caret;
        append(item?.message, item?.kind, caret?.file, caret?.line, caret?.['byte-column'],
          at?.finish?.line === caret?.line ? at.finish['byte-column'] : undefined);
        if (item?.children?.length) visit(item.children);
      }
    };
    // GCC emits one JSON array per translation unit.
    for (const document of output.trim().split(/\n(?=\[)/).filter(Boolean)) visit(JSON.parse(document));
  } else {
    for (const message of output.split('\n').filter(Boolean)) {
      const match = message.match(/^\/snapshot\/(.+?):(\d+):\s*(.*)$/);
      append(match?.[3] ?? message, /\bwarning\b/i.test(message) ? 'warning' : 'error',
        match ? '/snapshot/' + match[1] : undefined, match ? Number(match[2]) : undefined);
    }
  }
  return result;
}

// The only generated shell text contains platform commands and quoted filenames/base64 data.
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function diagnosticScript(packet: EditorDiagnosticsPacket): string {
  validateSnapshot(packet.snapshot);
  const source = packet.snapshot.files.find(file => file.fileId === packet.fileId);
  if (!source || !['c', 'hdl'].includes(packet.language)) throw new RunnerError('INVALID_REFERENCE', 'Diagnostic file unavailable');
  const files = packet.snapshot.files.filter(file => packet.language === 'c' ? /\.c$/i.test(file.path) : /\.(sv|v)$/i.test(file.path));
  const inputs = files.length ? files : packet.language === 'c' && /\.h$/i.test(source.path) ? [source] : [];
  if (!inputs.length) throw new RunnerError('INVALID_REQUEST', 'No diagnostic translation unit');
  const prepare = packet.snapshot.files.map(file => {
    const path = '/snapshot/' + file.path, parent = path.slice(0, path.lastIndexOf('/'));
    return `mkdir -p -- ${quote(parent)}\nprintf '%s' ${quote(Buffer.from(file.text).toString('base64'))} | base64 -d > ${quote(path)}\nchmod 444 -- ${quote(path)}`;
  }).join('\n');
  const args = packet.language === 'c'
    ? ['/usr/local/bin/gcc', '-std=c17', '-Wall', '-Wextra', '-pedantic', '-fsyntax-only', '-fdiagnostics-format=json',
      '-fno-diagnostics-json-formatting', '-fdiagnostics-column-unit=byte', '-fmax-errors=20', '-I/snapshot', ...(files.length ? [] : ['-x', 'c'])]
    : ['/usr/bin/iverilog', '-g2012', '-gno-std-include', '-I/snapshot', '-tnull'];
  return `set -eu\n${prepare}\nexec /usr/bin/timeout -k 1 5 ${[...args, ...inputs.map(file => '/snapshot/' + file.path)].map(quote).join(' ')}\n`;
}

export class EditorDiagnosticsNode {
  private active: { name: string; cancelled: boolean } | undefined;
  private stranded: string | undefined;
  private executor: DockerExecutor;
  private images: { c: string; hdl?: string };
  constructor(executor: DockerExecutor, images: { c: string; hdl?: string }) { this.executor = executor; this.images = images; }
  async preempt() {
    if (this.active) { this.active.cancelled = true; await this.executor.stop(this.active.name); }
  }
  async analyze(packet: EditorDiagnosticsPacket): Promise<EditorDiagnosticsResult> {
    const base = { sourceHash: packet.snapshot.hash, diagnostics: [] };
    if (this.active) return { ...base, status: 'busy' };
    const image = this.images[packet.language];
    if (!image || !/^sha256:[a-f0-9]{64}$/.test(image)) return { ...base, status: 'unavailable' };
    const script = diagnosticScript(packet), provider = packet.language === 'c' ? 'gcc' : 'iverilog';
    const active = { name: 'xunjie-editor-' + randomUUID(), cancelled: false };
    this.active = active;
    let timer: NodeJS.Timeout | undefined, retry: NodeJS.Timeout | undefined;
    let created = false, child: ReturnType<typeof spawn> | undefined;
    try {
      if (this.stranded) {
        if (!await this.executor.stop(this.stranded)) return { ...base, status: 'unavailable' };
        await this.executor.command(['rm', this.stranded]); this.stranded = undefined;
      }
      const id = await this.executor.command(['create', '--name', active.name, '--label', 'xunjie.editor=true',
        '--cpus=0.25', '--cpu-shares=128', '--memory=256m', '--memory-swap=256m', '--pids-limit=32',
        '--read-only', '--user=65534:65534', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--ipc=none', '--log-driver=none', '--interactive',
        '--tmpfs', '/snapshot:rw,noexec,nosuid,nodev,size=2m,uid=65534,gid=65534,mode=0700',
        '--tmpfs', '/work:rw,noexec,nosuid,nodev,size=8m,uid=65534,gid=65534,mode=0700',
        '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=6m,uid=65534,gid=65534,mode=0700',
        '--workdir=/work', '--env=LANG=C', '--env=LC_ALL=C', '--env=TMPDIR=/tmp',
        '--entrypoint=/usr/bin/timeout', image, '-k', '1', '10', '/bin/sh', '-s'], 5000);
      if (!/^[a-f0-9]{64}$/.test(id)) throw new RunnerError('DEPENDENCY_UNAVAILABLE', 'Diagnostic unit unavailable');
      created = true;
      if (active.cancelled) return { ...base, status: 'busy' };
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let bytes = 0, timedOut = false, overflow = false;
      child = spawn(this.executor.binary, [`--host=unix://${this.executor.socket}`, 'start', '--attach', '--interactive', id], {
        env: { PATH: '/usr/bin:/bin', DOCKER_CONFIG: this.executor.configDirectory }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      for (const [stream, chunks] of [[child.stdout!, stdout], [child.stderr!, stderr]] as const) stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk.subarray(0, Math.max(0, 65536 - bytes))); bytes += chunk.length;
        if (bytes > 65536) { overflow = true; void this.executor.stop(active.name); }
      });
      child.stdin!.on('error', () => {}); child.stdin!.end(script);
      timer = setTimeout(() => { timedOut = true; void this.executor.stop(active.name); child?.kill(); }, 12000);
      retry = setInterval(() => { if (active.cancelled || overflow || timedOut) void this.executor.stop(active.name); }, 100);
      await new Promise<void>((resolve, reject) => { child!.once('error', reject); child!.once('close', () => resolve()); });
      const state = (await this.executor.inspect(id)).State;
      if (active.cancelled) return { ...base, status: 'busy' };
      if (timedOut || [124, 137].includes(state.ExitCode) && !state.OOMKilled) return { ...base, status: 'timeout' };
      if (overflow || state.OOMKilled || state.Running || !['exited', 'dead'].includes(state.Status)) return { ...base, status: 'unavailable' };
      const output = Buffer.concat(stderr).toString('utf8');
      const diagnostics = parseCompilerDiagnostics(packet.language, output, packet.snapshot.files);
      if (state.ExitCode !== 0 && !diagnostics.length) return { ...base, status: 'unavailable' };
      return { sourceHash: packet.snapshot.hash, provider, status: 'ready', diagnostics };
    } catch { return { ...base, status: 'unavailable' }; }
    finally {
      clearTimeout(timer); clearInterval(retry);
      if (created) {
        if (await this.executor.stop(active.name)) {
          try { await this.executor.command(['rm', active.name]); } catch { this.stranded = active.name; }
        } else this.stranded = active.name;
      }
      this.active = undefined;
    }
  }
}
