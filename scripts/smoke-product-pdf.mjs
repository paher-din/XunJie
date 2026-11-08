// Run with the candidate's own Node. No workspace dependencies or PDF tools.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, lstat, realpath, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { deflateSync } from 'node:zlib';

const { values } = parseArgs({ options: { product: { type: 'string' }, pdf: { type: 'string' }, out: { type: 'string' } } });
assert(values.product, '--product is required');
const product = resolve(values.product);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { formatVersion: 1, startedAt: new Date().toISOString(), state: 'running',
  platform: `${process.platform}-${process.arch}`, nodeVersion: process.version, cases: [] };

async function size(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  const sizes = await Promise.all((await readdir(path)).map(name => size(join(path, name))));
  return sizes.reduce((sum, bytes) => sum + bytes, 0);
}
function fixture(pageCount = 3) {
  // Distinct visible CropBox, rotation, printed labels, native text and a scan.
  const objects = [];
  const add = value => { objects.push(Buffer.isBuffer(value) ? value : Buffer.from(value)); return objects.length; };
  const stream = (metadata, bytes) => Buffer.concat([Buffer.from(`<< ${metadata} /Length ${bytes.length} >>\nstream\n`), bytes, Buffer.from('\nendstream')]);
  add('<< /Type /Catalog /Pages 2 0 R /PageLabels << /Nums [0 << /S /r >> 1 << /S /D /P (A-) >> 2 << /P (scan) >>] >> >>');
  add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const rgb = Buffer.alloc(640 * 400 * 3);
  for (let y = 0; y < 400; y++) for (let x = 0; x < 640; x++) {
    const offset = (y * 640 + x) * 3;
    const stripe = (Math.floor(x / 32) + Math.floor(y / 20)) % 2 === 0;
    rgb[offset] = stripe ? 20 : 210; rgb[offset + 1] = stripe ? 70 : 230; rgb[offset + 2] = stripe ? 180 : 40;
  }
  const image = add(stream('/Type /XObject /Subtype /Image /Width 640 /Height 400 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode', deflateSync(rgb)));
  const kids = [];
  for (let i = 0; i < pageCount; i++) {
    const content = Buffer.from(i === 0 ? 'BT /F1 18 Tf 40 200 Td (XunJie PDF native marker 218) Tj ET\n0 0 1 RG 2 w 30 30 m 370 230 l S'
      : i === 1 ? '1 0 0 rg 30 40 170 110 re f\n0 1 0 rg 200 40 170 110 re f\n0 0 1 rg 30 150 170 110 re f\n1 1 0 rg 200 150 170 110 re f'
        : 'q 400 0 0 250 0 0 cm /Scan Do Q');
    const commands = add(stream('', content));
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] ${i === 1 ? '/CropBox [30 40 370 260] /Rotate 90' : ''}
      /Resources << /Font << /F1 ${font} 0 R >> /XObject << /Scan ${image} 0 R >> >> /Contents ${commands} 0 R >>`));
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Count ${kids.length} /Kids [${kids.map(id => `${id} 0 R`).join(' ')}] >>`);
  const pieces = [Buffer.from('%PDF-1.7\n')], offsets = [0];
  let offset = pieces[0].length;
  objects.forEach((body, i) => {
    offsets.push(offset);
    const item = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    pieces.push(item); offset += item.length;
  });
  pieces.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(pieces);
}
async function main() {
  const distributionBytes = await readFile(join(product, 'distribution.json'));
  const distribution = JSON.parse(distributionBytes);
  assert.equal(distribution.platform, report.platform);
  const resources = JSON.parse(await readFile(join(product, 'resources.json')));
  const node = join(product, resources.nodePath);
  assert.equal(await realpath(process.execPath), await realpath(node), 'Use the product Node, not a system Node');
  assert.equal(process.version, 'v24.21.0');
  const worker = join(product, 'app/pdf-engine-worker.js');
  const runtime = JSON.parse(await readFile(join(product, 'app/pdf-runtime.json')));
  assert.equal(runtime.platform, report.platform);
  assert.equal(runtime.worker, basename(worker));
  const require = createRequire(join(product, 'app/probe.cjs'));
  const canvas = require('@napi-rs/canvas');
  const native = require.resolve(runtime.nativePackage);
  for (const [name, version] of [['pdfjs-dist', '6.5.438'], ['@napi-rs/canvas', '1.1.0'], [runtime.nativePackage, '1.1.0']]) {
    assert.equal(require(`${name}/package.json`).version, version);
  }
  for (const directory of runtime.resources) {
    assert((await readdir(join(product, 'app/node_modules/pdfjs-dist', directory))).length > 0);
  }
  for (const path of ['app/pdf-engine-worker.js', 'app/node_modules/pdfjs-dist/legacy/build/pdf.mjs',
    'app/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', 'app/licenses/pdf-native/NOTICE-PDF.txt']) {
    assert.equal(sha(await readFile(join(product, path))), distribution.entryHashes[path]?.sha256, `Untracked or changed ${path}`);
  }
  const licenses = JSON.parse(await readFile(join(product, 'app/licenses.json')));
  for (const name of ['pdfjs-dist', '@napi-rs/canvas', runtime.nativePackage]) assert(licenses.some(entry => entry.name === name));
  const nativeRelative = native.slice(product.length + 1).replaceAll('\\', '/');
  assert.equal(sha(await readFile(native)), distribution.entryHashes[nativeRelative]?.sha256);
  const sources = JSON.parse(await readFile(join(product, 'app/licenses/pdf-native/sources-canvas-rust-1.1.0.json')));
  assert(sources.length > 0 && sources.every(record => record.error === null));
  report.distribution = { sha256: sha(distributionBytes), platform: distribution.platform, profile: distribution.profile,
    workerSha256: sha(await readFile(worker)), nodeSha256: sha(await readFile(node)), nativeSha256: sha(await readFile(native)),
    nativePackage: runtime.nativePackage, nativeIntegrity: runtime.nativeIntegrity,
    bytes: { product: await size(product), pdfjs: await size(join(product, 'app/node_modules/pdfjs-dist')),
      canvas: await size(join(product, 'app/node_modules/@napi-rs/canvas')), native: await size(dirname(native)),
      pdfNativeLicenses: await size(join(product, 'app/licenses/pdf-native')) },
    licenseRecords: licenses.filter(entry => ['pdfjs-dist', '@napi-rs/canvas', runtime.nativePackage].includes(entry.name)) };

  async function run(input, request) {
    return new Promise((done, reject) => {
      const env = { DISABLE_SYSTEM_FONTS_LOAD: '1', PATH: '' };
      for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];
      const child = spawn(node, ['--max-old-space-size=256', '--disallow-code-generation-from-strings', worker, JSON.stringify(request)],
        { cwd: product, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const stdout = [], stderr = [];
      let bytes = 0, stderrBytes = 0, failure;
      const timeout = setTimeout(() => { failure = new Error('PDF smoke child timed out'); child.kill('SIGKILL'); }, 30_000);
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) { failure = new Error('PDF smoke child output limit'); child.kill('SIGKILL'); }
        else stdout.push(chunk);
      });
      child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes <= 4096) stderr.push(chunk); });
      child.stdin.on('error', () => {});
      child.once('error', error => { failure = error; });
      child.once('close', code => {
        clearTimeout(timeout);
        if (failure || code !== 0) return reject(failure ?? new Error(`PDF child exit ${code}: ${Buffer.concat(stderr).toString('utf8')}`));
        try {
          const messages = Buffer.concat(stdout).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
          const final = messages.at(-1);
          done(final?.complete ? messages.filter(message => message.pageResult).map(message => message.pageResult) : final);
        } catch (error) { reject(error); }
      });
      child.stdin.end(input);
    });
  }
  async function checkPage(page) {
    assert.equal(page.state, 'ready'); assert.equal(page.textOrigin, 'native'); assert.equal(page.ocr, 'not-performed');
    assert.equal(page.transform.engine, 'pdfjs-dist@6.5.438/@napi-rs/canvas@1.1.0');
    assert.equal(page.transform.cropBox.length, 4);
    const png = Buffer.from(page.image.dataBase64, 'base64');
    assert(png.length <= 262144 && png.length > 100); assert.equal(sha(png), page.image.sha256);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), page.image.width); assert.equal(png.readUInt32BE(20), page.image.height);
    assert(Math.max(page.image.width, page.image.height) >= 512 && Math.max(page.image.width, page.image.height) <= 2048);
    const decoded = await canvas.loadImage(png), surface = canvas.createCanvas(decoded.width, decoded.height);
    const context = surface.getContext('2d'); context.drawImage(decoded, 0, 0);
    const center = [...context.getImageData(Math.floor(decoded.width / 2), Math.floor(decoded.height / 2), 1, 1).data];
    surface.width = surface.height = 1;
    return { page: page.page, label: page.label, state: page.state, textSha256: sha(page.text), textBytes: Buffer.byteLength(page.text),
      pngSha256: page.image.sha256, pngBytes: png.length, width: page.image.width, height: page.image.height,
      center, transform: page.transform, detail: page.detail };
  }
  const bytes = fixture(), inputSha256 = sha(bytes);
  const inspection = await run(bytes, { mode: 'inspect' });
  report.cases.push({ name: 'inspect-labels', inputSha256, result: inspection });
  assert.equal(inspection.state, 'ready', `Product worker inspection: ${JSON.stringify(inspection)}`);
  assert.equal(inspection.pageCount, 3); assert.deepEqual(inspection.pageLabels, ['i', 'A-1', 'scan']);
  const digital = await run(bytes, { mode: 'render', pages: [1, 2], region: null });
  assert.deepEqual(digital.map(page => page.page), [1, 2]);
  assert(digital[0].text.includes('XunJie PDF native marker 218'));
  report.cases.push({ name: 'native-text-and-rotated-page', pages: await Promise.all(digital.map(checkPage)) });
  const region = { x: 0, y: 0, width: 0.5, height: 0.5 };
  const cropped = await run(bytes, { mode: 'render', pages: [2, 3], region });
  const croppedSummaries = await Promise.all(cropped.map(checkPage));
  assert.equal(cropped[0].transform.rotation, 90); assert.deepEqual(cropped[0].transform.cropBox, [30, 40, 370, 260]);
  assert.deepEqual(cropped[0].transform.region, region);
  assert(croppedSummaries[0].center[0] > 240 && croppedSummaries[0].center[1] < 10 && croppedSummaries[0].center[2] < 10, 'Rotated CropBox top-left must be red');
  assert.equal(cropped[1].text, ''); assert(croppedSummaries[1].center.some((value, i) => i < 3 && value < 240), 'Scan must render nonwhite pixels');
  report.cases.push({ name: 'rotated-cropbox-region-and-scan', pages: croppedSummaries });
  const mixed = await run(bytes, { mode: 'render', pages: [100000, 1], region: null });
  assert.deepEqual(mixed.map(page => [page.page, page.state]), [[100000, 'out-of-range'], [1, 'ready']]);
  report.cases.push({ name: 'ordered-independent-page-error', pages: [mixed[0], await checkPage(mixed[1])] });
  const damaged = await run(Buffer.from('%PDF-1.7\nbroken\n'), { mode: 'inspect' });
  assert.equal(damaged.state, 'damaged'); report.cases.push({ name: 'damaged', result: damaged });
  const tooMany = await run(fixture(201), { mode: 'inspect' });
  assert.equal(tooMany.state, 'limit'); assert.equal(tooMany.pageCount, 201);
  report.cases.push({ name: 'page-limit', result: tooMany });
  if (values.pdf) {
    const course = await readFile(resolve(values.pdf));
    const metadata = await run(course, { mode: 'inspect' }); assert.equal(metadata.state, 'ready');
    const pages = await run(course, { mode: 'render', pages: [1, Math.min(2, metadata.pageCount)], region: null });
    report.cases.push({ name: 'public-course-pdf', source: basename(values.pdf), inputSha256: sha(course),
      inspection: metadata, pages: await Promise.all(pages.map(checkPage)) });
  }
  report.state = 'passed';
}
try { await main(); }
catch (error) { report.state = 'failed'; report.error = { name: error.name, message: error.message.slice(0, 2000) }; process.exitCode = 1; }
report.finishedAt = new Date().toISOString();
if (values.out) { await mkdir(dirname(resolve(values.out)), { recursive: true }); await writeFile(resolve(values.out), JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(report, null, 2));
