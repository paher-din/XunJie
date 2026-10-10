import assert from 'node:assert/strict';
import { test } from 'node:test';
import { manifestHash, sha256 } from './snapshot.ts';
import { textScopeArgs } from './run-snapshot.ts';

const text = 'C and memory.\n';
const files = [{ fileId: 'input-1', path: 'data/a;touch marker.txt', documentVersion: 1, text, contentHash: sha256(text) }];
const snapshot = { snapshotId: 'synthetic-input', hashFormat: 'sha256-manifest-v1' as const, hash: manifestHash(files), files };

test('maps four course operations to arrays and resolves files by immutable identity', () => {
  const fileIds = ['input-1'];
  assert.deepEqual(textScopeArgs(snapshot, { operation: 'stats', fileIds }, []), ['stats', '/snapshot/data/a;touch marker.txt']);
  assert.deepEqual(textScopeArgs(snapshot, { operation: 'find', fileIds, word: 'Memory' }, []), ['find', 'Memory', '/snapshot/data/a;touch marker.txt']);
  assert.deepEqual(textScopeArgs(snapshot, { operation: 'top', fileIds, count: '5' }, []), ['top', '-n', '5', '/snapshot/data/a;touch marker.txt']);
  assert.deepEqual(textScopeArgs(snapshot, { operation: 'report', fileIds, resultFile: 'report.txt' }, ['report.txt']),
    ['report', '-o', '/work/report.txt', '/snapshot/data/a;touch marker.txt']);
});

test('rejects unapproved files, command/word injection, zero count and output escape', () => {
  assert.throws(() => textScopeArgs(snapshot, { operation: 'stats', fileIds: ['other'] }, []), /approved ASCII/);
  assert.throws(() => textScopeArgs(snapshot, { operation: 'find', fileIds: ['input-1'], word: '$(command)' }, []), /ASCII word/);
  assert.throws(() => textScopeArgs(snapshot, { operation: 'top', fileIds: ['input-1'], count: '0' }, []), /positive integer/);
  assert.throws(() => textScopeArgs(snapshot, { operation: 'report', fileIds: ['input-1'], resultFile: '../a.txt' }, ['../a.txt']), /relative path/);
  assert.throws(() => textScopeArgs(snapshot, { operation: 'report', fileIds: ['input-1'], resultFile: 'other.txt' }, ['report.txt']), /not approved/);
});
