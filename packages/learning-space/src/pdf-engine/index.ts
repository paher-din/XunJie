import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { emptyPage, LIMITS } from './protocol.js';
import type { Inspection, PdfPage, Region } from './protocol.js';
export type { Inspection, PdfPage, Region } from './protocol.js';

// One active child and at most two queued requests, including their input copies.
let pending = 0;
let tail: Promise<void> = Promise.resolve();
type Failure = { state: 'limit' | 'timeout' | 'failed'; detail: string };
async function execute(bytes: Uint8Array, request: { mode: string; pages?: number[]; region?: Region | null }): Promise<unknown | Failure> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return { state: 'failed', detail: 'PDF input is empty.' };
  if (bytes.byteLength > LIMITS.bytes) return { state: 'limit', detail: 'PDF exceeds 20 MiB.' };
  if (pending >= 3) return { state: 'limit', detail: 'PDF queue is full (one active, two waiting).' };
  const input = Uint8Array.from(bytes); // Fix bytes before waiting or transferring ownership.
  const deadline = Date.now() + LIMITS.milliseconds;
  pending++;
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>(resolve => { release = resolve; });
  try {
    await previous;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { state: 'timeout', detail: 'PDF deadline expired in queue.' };
    return await new Promise<unknown | Failure>(resolve => {
      const worker = new URL('./pdf-engine-worker.js', import.meta.url);
      const env: NodeJS.ProcessEnv = { DISABLE_SYSTEM_FONTS_LOAD: '1' };
      for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG']) {
        if (process.env[key]) env[key] = process.env[key];
      }
      const child = spawn(process.execPath, ['--max-old-space-size=256', '--disallow-code-generation-from-strings', fileURLToPath(worker), JSON.stringify(request)],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: tmpdir(), env });
      const chunks: Buffer[] = [];
      const completed: PdfPage[] = [];
      const decoder = new StringDecoder('utf8');
      let partialLine = '';
      let size = 0;
      let failure: Failure | undefined;
      const timer = setTimeout(() => {
        failure = { state: 'timeout', detail: 'PDF exceeded 30 second deadline.' };
        child.kill('SIGKILL');
      }, remaining);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > LIMITS.response) {
          failure = { state: 'limit', detail: 'PDF response exceeds output limit.' };
          child.kill('SIGKILL');
        } else {
          chunks.push(chunk);
          partialLine += decoder.write(chunk);
          let newline;
          while ((newline = partialLine.indexOf('\n')) >= 0) {
            const line = partialLine.slice(0, newline);
            partialLine = partialLine.slice(newline + 1);
            try {
              const progress = JSON.parse(line) as { pageResult?: PdfPage };
              if (progress.pageResult && progress.pageResult.page === request.pages?.[completed.length]) completed.push(progress.pageResult);
            } catch { /* Final framing validation below rejects a malformed response. */ }
          }
        }
      });
      child.stderr.resume(); // Diagnostics must never corrupt the framed stdout response.
      child.stdin.on('error', () => {}); // Early child exit is handled by close.
      child.once('error', () => { failure = { state: 'failed', detail: 'PDF child could not start.' }; });
      child.once('close', code => {
        clearTimeout(timer);
        if (code !== 0 && !failure) failure = { state: 'failed', detail: 'PDF child exited before completing.' };
        if (failure) return resolve(request.mode === 'render' ? request.pages!.map((page, index) => completed[index]
          ?? emptyPage(page, request.region ?? null, failure!.state, failure!.detail)) : failure);
        try {
          const lines = Buffer.concat(chunks).toString('utf8').trimEnd().split('\n');
          const result = JSON.parse(lines.at(-1) ?? '') as { complete?: boolean; state?: Failure['state']; detail?: string };
          if (result.complete) {
            if (completed.length !== request.pages?.length) throw new Error('Incomplete page response.');
            resolve(completed);
          } else if (request.mode === 'render' && completed.length) {
            resolve(request.pages!.map((page, index) => completed[index] ?? emptyPage(page, request.region ?? null,
              result.state === 'timeout' ? 'timeout' : result.state === 'limit' ? 'limit' : 'failed', result.detail ?? 'PDF child did not complete.')));
          } else resolve(result);
        }
        catch { resolve({ state: 'failed', detail: 'Invalid PDF child response.' }); }
      });
      child.stdin.end(input);
    });
  } finally { pending--; release(); }
}

export async function inspectPdf(bytes: Uint8Array): Promise<Inspection> {
  const result = await execute(bytes, { mode: 'inspect' }) as Inspection;
  return { ...result, pageCount: result.pageCount ?? 0, pageLabels: result.pageLabels ?? [] };
}

export async function renderPdf(bytes: Uint8Array, pages: number[], region: Region | null): Promise<PdfPage[]> {
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 2 || new Set(pages).size !== pages.length
    || pages.some(page => !Number.isSafeInteger(page) || page < 1 || page > 100000)) {
    throw new RangeError('Select one or two distinct actual PDF page indices (1..100000).');
  }
  if (region !== null && (!region || ![region.x, region.y, region.width, region.height].every(Number.isFinite)
    || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0
    || region.x + region.width > 1 || region.y + region.height > 1)) throw new RangeError('Invalid normalized PDF region.');
  const selected = [...pages];
  const fixedRegion = region === null ? null : { ...region };
  const result = await execute(bytes, { mode: 'render', pages: selected, region: fixedRegion }) as PdfPage[] | Inspection;
  if (Array.isArray(result)) return result;
  const state = result.state === 'timeout' ? 'timeout' : result.state === 'limit' ? 'limit' : 'failed';
  return selected.map(page => emptyPage(page, fixedRegion, state, result.detail ?? `PDF ${result.state}.`));
}
