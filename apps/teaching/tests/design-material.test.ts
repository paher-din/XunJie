import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareMaterial } from '../server/design/material.ts';

test('UTF-8 material preserves the original text and produces its known SHA-256 reference', () => {
  const result = prepareMaterial({ format: 'txt', title: 'Synthetic', content: Buffer.from('abc') }, 0);
  assert.equal(result.text, 'abc');
  assert.equal(result.byteLength, 3);
  assert.equal(result.contentHash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.deepEqual(result.paragraphs.map(p => ({ ordinal: p.ordinal, start: p.start, end: p.end, text: p.text })), [{ ordinal: 1, start: 0, end: 3, text: 'abc' }]);
  assert.deepEqual(result.visibility, { student: false, tutor: false });
});


test('BOM, CRLF, Chinese, astral characters and trailing spaces retain exact paragraph boundaries', () => {
  const text = '\uFEFF# 课\r\n正文🙂 \r\n\r\n末尾  ';
  const result = prepareMaterial({ format: 'markdown', title: '课', content: Buffer.from(text) }, 0);
  assert.equal(result.text, text);
  assert.equal(result.byteLength, 33);
  assert.deepEqual(result.paragraphs.map(p => ({ start: p.start, end: p.end, text: p.text })), [
    { start: 0, end: 11, text: '\uFEFF# 课\r\n正文🙂 ' },
    { start: 15, end: 19, text: '末尾  ' },
  ]);
});


test('material rejects malformed UTF-8, unsupported formats, forged fields and private audience exposure', () => {
  for (const content of [Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), '\ud800']) {
    assert.throws(() => prepareMaterial({ format: 'txt', title: 'Synthetic', content }, 0), { code: 'INVALID_REQUEST' });
  }
  assert.throws(() => prepareMaterial({ format: 'pdf', title: 'Synthetic', content: 'abc' }, 0), { code: 'INVALID_REQUEST' });
  assert.throws(() => prepareMaterial({ format: 'paste', title: 'Synthetic', content: 'abc', role: 'teacher' }, 0), { code: 'INVALID_REQUEST' });
  for (const kind of ['private_answer', 'validation_asset']) {
    assert.throws(() => prepareMaterial({ format: 'txt', title: 'Private', content: 'synthetic secret', kind, visibility: { student: false, tutor: true } }, 0), { code: 'FORBIDDEN' });
  }
  const script = '<script>synthetic()</script>';
  assert.equal(prepareMaterial({ format: 'markdown', title: 'Untrusted', content: script }, 0).text, script);
});

test('material byte limits count UTF-8 bytes and course usage, allowing the exact maximum', () => {
  const input = { format: 'paste', title: 'Synthetic', content: 'a'.repeat(262144) };
  assert.equal(prepareMaterial(input, 1835008).byteLength, 262144);
  assert.throws(() => prepareMaterial({ ...input, content: 'a'.repeat(262145) }, 0), { code: 'CONTENT_LIMIT' });
  assert.throws(() => prepareMaterial(input, 1835009), { code: 'CONTENT_LIMIT' });
  assert.throws(() => prepareMaterial({ ...input, content: '中'.repeat(87382) }, 0), { code: 'CONTENT_LIMIT' });
  for (const usage of [-1, 0.5, NaN, Infinity]) assert.throws(() => prepareMaterial(input, usage), { code: 'INVALID_REQUEST' });
  assert.equal(prepareMaterial({ format: 'txt', title: 'Empty', content: Buffer.alloc(0) }, 0).paragraphs.length, 0);
});
