import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emptyPage, LIMITS } from './protocol.js';
import type { Inspection, PdfPage, Region } from './protocol.js';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/types/src/display/api.js';

// Only fixed stdin bytes and shipped resource paths enter PDF.js. No PDF URLs,
// link traversal, document scripting, XFA, OCR, or network resource fetches.
globalThis.fetch = async () => { throw new Error('PDF network access disabled.'); };
const request = JSON.parse(process.argv[2] ?? '{}') as { mode: string; pages?: number[]; region?: Region | null };
const require = createRequire(import.meta.url);
const assets = dirname(require.resolve('pdfjs-dist/package.json'));
// PDF.js requires directory URLs ending in '/', including on Windows.
const assetUrl = (directory: string) => pathToFileURL(join(assets, directory) + sep).href;

async function readInput(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of process.stdin) {
    const chunk = value as Buffer;
    length += chunk.length;
    if (length > LIMITS.bytes) throw new Error('input-limit');
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
function failure(error: unknown): Inspection {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  const state = message === 'input-limit' ? 'limit' : name === 'PasswordException' ? 'encrypted'
    : ['InvalidPDFException', 'FormatError'].includes(name) ? 'damaged' : 'failed';
  return { state, pageCount: 0, pageLabels: [], detail: state === 'encrypted' ? 'Password-protected PDF is unsupported.'
    : state === 'damaged' ? 'PDF structure is damaged.' : state === 'limit' ? 'PDF exceeds 20 MiB.' : 'PDF parsing failed.' };
}
async function render(document: PDFDocumentProxy, pageNumber: number, labels: string[], region: Region | null): Promise<PdfPage> {
  const result = emptyPage(pageNumber, region, 'failed', 'PDF page failed.');
  result.label = labels[pageNumber - 1] ?? String(pageNumber);
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) {
    result.state = 'out-of-range'; result.detail = 'Actual PDF page index is outside the document; page geometry is unavailable.'; return result;
  }
  let page: PDFPageProxy | undefined;
  try {
    page = await document.getPage(pageNumber);
    result.transform.rotation = page.rotate;
    result.transform.cropBox = [...page.view];
    const viewport = page.getViewport({ scale: 1 });
    const area = region ?? { x: 0, y: 0, width: 1, height: 1 };
    const width = viewport.width * area.width, height = viewport.height * area.height;
    if (![width, height].every(value => Number.isFinite(value) && value > 0)) throw new Error('Invalid page dimensions.');
    const content = await page.streamTextContent();
    const reader = content.getReader();
    let textBytes = 0;
    const text: string[] = [];
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        for (const item of next.value.items) {
          if (!('str' in item)) continue;
          const part = item.str + (item.hasEOL ? '\n' : ' ');
          textBytes += Buffer.byteLength(part);
          if (textBytes > LIMITS.text) {
            await reader.cancel(); result.state = 'limit'; result.detail = 'Native page text exceeds 128 KiB; no complete text returned.'; return result;
          }
          text.push(part);
        }
      }
    } finally { reader.releaseLock(); }
    result.text = text.join('').trim();
    const { createCanvas } = await import('@napi-rs/canvas');
    for (const edge of [2048, 1536, 1024, 768, 512]) {
      const scale = edge / Math.max(width, height);
      const scaled = page.getViewport({ scale });
      const outputWidth = Math.max(1, Math.min(2048, Math.ceil(width * scale)));
      const outputHeight = Math.max(1, Math.min(2048, Math.ceil(height * scale)));
      if (outputWidth * outputHeight > LIMITS.pixels) continue;
      const canvas = createCanvas(outputWidth, outputHeight);
      try {
        await page.render({ canvas: canvas as unknown as Parameters<PDFPageProxy['render']>[0]['canvas'],
          canvasContext: canvas.getContext('2d') as unknown as Parameters<PDFPageProxy['render']>[0]['canvasContext'],
          viewport: scaled, transform: [1, 0, 0, 1, -scaled.width * area.x, -scaled.height * area.y],
          background: 'rgb(255,255,255)' }).promise;
        const png = await canvas.encode('png');
        if (png.length > LIMITS.png) continue;
        result.image = { mediaType: 'image/png', dataBase64: png.toString('base64'), width: outputWidth, height: outputHeight,
          sha256: createHash('sha256').update(png).digest('hex') };
        result.transform.scale = scale;
        result.state = 'ready';
        result.detail = `${region ? '文字来自整页原生文字层，未按所选区域过滤。' : '文字来自整页原生文字层。'}页图长边 ${edge}px，细节可能不足；未执行 OCR。`;
        return result;
      } finally { canvas.width = 1; canvas.height = 1; }
    }
    result.state = 'limit'; result.detail = 'PNG exceeds 256 KiB even at 512px long edge; no page image returned. Text is from the entire native page.';
  } catch (error) {
    const imageLimit = error instanceof Error && error.message.includes('Image exceeded maximum allowed size');
    result.state = imageLimit ? 'limit' : 'failed';
    result.detail = imageLimit ? 'Source image exceeds 16 megapixels; no complete page image returned. Text is from the entire native page.'
      : `This PDF page could not be read or rendered.${page ? '' : ' Page geometry is unavailable.'}`;
  }
  finally { page?.cleanup(); }
  return result;
}

async function main(): Promise<Inspection | PdfPage[]> {
  const bytes = await readInput();
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: bytes, cMapUrl: assetUrl('cmaps'), cMapPacked: true,
    standardFontDataUrl: assetUrl('standard_fonts'), wasmUrl: assetUrl('wasm'),
    iccUrl: assetUrl('iccs'), useWorkerFetch: false, useSystemFonts: false,
    enableXfa: false, stopAtErrors: true, maxImageSize: LIMITS.sourceImagePixels, verbosity: 0 });
  try {
    const document = await task.promise;
    if (document.numPages > LIMITS.pages) return { state: 'limit', pageCount: document.numPages, pageLabels: [], detail: 'PDF exceeds 200 pages.' };
    const labels = (await document.getPageLabels()) ?? Array.from({ length: document.numPages }, (_, i) => String(i + 1));
    if (labels.length !== document.numPages || labels.some(label => label.length > 300)) {
      return { state: 'limit', pageCount: document.numPages, pageLabels: [], detail: 'PDF page labels exceed supported bounds.' };
    }
    if (request.mode === 'inspect') return { state: 'ready', pageCount: document.numPages, pageLabels: labels };
    const results: PdfPage[] = [];
    for (const number of request.pages ?? []) {
      const pageResult = await render(document, number, labels, request.region ?? null);
      results.push(pageResult);
      process.stdout.write(JSON.stringify({ pageResult }) + '\n');
    }
    return results;
  } finally { await task.destroy(); }
}
// PDF.js occasionally emits warnings through console.log; stdout is protocol only.
console.log = () => {};
console.warn = () => {};
main().catch(failure).then(result => {
  const output = JSON.stringify(Array.isArray(result) ? { complete: true } : result) + '\n';
  process.stdout.write(output, () => process.exit(0));
});
