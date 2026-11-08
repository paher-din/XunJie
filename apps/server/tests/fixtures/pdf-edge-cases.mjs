import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createCanvas } from '@napi-rs/canvas';

/** Small binary-safe PDFs with independent object/xref construction, not PDF engine output. */
function pdf(objects, trailer = '') {
  const chunks = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')], offsets = [0];
  let length = chunks[0].length;
  for (const [index, value] of objects.entries()) {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(value), Buffer.from('\nendobj\n')]);
    chunks.push(chunk); length += chunk.length;
  }
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
function stream(bytes, fields = '') {
  const body = Buffer.from(bytes);
  return Buffer.concat([Buffer.from(`<< /Length ${body.length} ${fields} >>\nstream\n`), body, Buffer.from('\nendstream')]);
}
export const damagedPdf = () => Buffer.from('%PDF-1.7\nDeliberately missing catalog, pages, xref and trailer.\n%%EOF\n');
export function replacementPdf() {
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream('BT /F1 18 Tf 30 150 Td (Replacement evidence: 91 amps) Tj ET'),
  ]);
}

export const rotatedRegion = Object.freeze({ x: 0.1, y: 0.1, width: 0.3, height: 0.2 });
/** PDF-space CropBox quadrants become red/blue/green/yellow in rotated viewport reading order. */
export function rotatedCropPdf() {
  const content = '1 0 1 rg 0 0 300 200 re f\n'
    + '1 0 0 rg 40 30 100 50 re f\n0 1 0 rg 140 30 100 50 re f\n'
    + '0 0 1 rg 40 80 100 50 re f\n1 1 0 rg 140 80 100 50 re f\n'
    + '0 0 0 rg BT /F1 8 Tf 150 40 Td (Outside region: 42) Tj ET';
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /CropBox [40 30 240 130] /Rotate 90 '
      + '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', stream(content),
  ]);
}

/** A real raster-only scan: fixed pixels draw "37"; the PDF has no fonts or text operators. */
export function scannedPdf() {
  const width = 96, height = 64, canvas = createCanvas(width, height), context = canvas.getContext('2d');
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
  const glyphs = ['1110111', '0010001', '1110001', '0010001', '1110001'];
  context.fillStyle = '#000000';
  for (const [y, row] of glyphs.entries()) for (const [x, bit] of [...row].entries())
    if (bit === '1') context.fillRect(12 + x * 7, 12 + y * 7, 5, 5);
  context.fillStyle = '#ff0000'; context.fillRect(70, 12, 12, 12);
  const rgba = context.getImageData(0, 0, width, height).data, rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = rgba[i * 4]; rgb[i * 3 + 1] = rgba[i * 4 + 1]; rgb[i * 3 + 2] = rgba[i * 4 + 2];
  }
  canvas.width = 1; canvas.height = 1;
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 96 64] /Resources << /XObject << /Scan 4 0 R >> >> /Contents 5 0 R >>',
    stream(deflateSync(rgb), '/Type /XObject /Subtype /Image /Width 96 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode'),
    stream('q 96 0 0 64 0 0 cm /Scan Do Q'),
  ]);
}

// Standard security handler R2, with a genuinely encrypted content stream. Pure JS RC4 keeps
// this fixture independent of external executables and OpenSSL's optional legacy provider.
const passwordPadding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const md5 = bytes => createHash('md5').update(bytes).digest();
function padded(password) { return Buffer.concat([Buffer.from(password, 'latin1'), passwordPadding]).subarray(0, 32); }
function rc4(key, bytes) {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index), output = Buffer.alloc(bytes.length);
  let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + state[i] + key[i % key.length]) & 255; [state[i], state[j]] = [state[j], state[i]]; }
  let i = 0; j = 0;
  for (let n = 0; n < bytes.length; n++) {
    i = (i + 1) & 255; j = (j + state[i]) & 255; [state[i], state[j]] = [state[j], state[i]];
    output[n] = bytes[n] ^ state[(state[i] + state[j]) & 255];
  }
  return output;
}
export const fixturePassword = 'synthetic-pdf-user';
export function encryptedPdf() {
  const id = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const owner = rc4(md5(padded('synthetic-pdf-owner')).subarray(0, 5), padded(fixturePassword));
  const permissions = Buffer.alloc(4); permissions.writeInt32LE(-4);
  const key = md5(Buffer.concat([padded(fixturePassword), owner, permissions, id])).subarray(0, 5);
  const user = rc4(key, passwordPadding);
  const objectKey = md5(Buffer.concat([key, Buffer.from([5, 0, 0, 0, 0])])).subarray(0, 10);
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream(rc4(objectKey, Buffer.from('BT /F1 18 Tf 30 150 Td (Protected fixture content) Tj ET'))),
    `<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> >>`,
  ], `/Encrypt 6 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>]`);
}
