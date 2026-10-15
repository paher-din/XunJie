import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCompilerDiagnostics } from './editor-diagnostics.ts';
import { sha256 } from './snapshot.ts';

const source = { fileId: 'file-1', path: 'inc/源.h', documentVersion: 1,
  text: '/* 中文😀 */ int n = ;\r\n', contentHash: '' };
source.contentHash = sha256(source.text);
test('GCC byte columns become UTF-16, including Chinese/emoji and inclusive end', () => {
  const byteColumn = Buffer.byteLength('/* 中文😀 */ int n = ') + 1;
  const output = JSON.stringify([{ kind: 'error', message: 'expected expression', locations: [{
    caret: { file: '/snapshot/inc/源.h', line: 1, 'byte-column': byteColumn },
    finish: { file: '/snapshot/inc/源.h', line: 1, 'byte-column': byteColumn },
  }] }]);
  const result = parseCompilerDiagnostics('c', output, [source]);
  assert.equal(result[0]?.range?.startColumn, '/* 中文😀 */ int n = '.length + 1);
  assert.equal(result[0]?.range?.endColumn, '/* 中文😀 */ int n = ;'.length + 1);
  assert.equal(result[0]?.contentHash, source.contentHash);
  assert.equal(parseCompilerDiagnostics('c', JSON.stringify(JSON.parse(output), null, 2) + '\n[]\n', [source]).length, 1);
  const bomSource = { ...source, text: '\ufeff' + source.text, contentHash: sha256('\ufeff' + source.text) };
  assert.equal(parseCompilerDiagnostics('c', output, [bomSource])[0]?.range?.startColumn, result[0]!.range!.startColumn + 1);
});
test('HDL locations remain whole lines; external paths and invalid columns never acquire a file', () => {
  const result = parseCompilerDiagnostics('hdl', '/snapshot/inc/源.h:1: syntax error\n/etc/passwd:1: failure', [source]);
  assert.equal(result[0]?.line, 1); assert.equal(result[0]?.range, undefined);
  assert.equal(result[1]?.fileId, undefined);
  const invalid = parseCompilerDiagnostics('c', JSON.stringify([{ kind: 'error', message: 'bad',
    locations: [{ caret: { file: '/snapshot/inc/源.h', line: 500, 'byte-column': 900 } }] }]), [source]);
  assert.equal(invalid[0]?.range, undefined); assert.equal(invalid[0]?.line, undefined);
});
