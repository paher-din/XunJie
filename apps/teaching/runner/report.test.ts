import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedReport, matchesReport } from './report.ts';

const inputs = [
  { path: 'a.txt', text: 'C is fun.\nC is fast.\nMemory matters.\n' },
  { path: 'b.txt', text: 'C and memory.\n' },
];
const correct = 'FILE "a.txt" 3 8 37\nFILE "b.txt" 1 3 14\nTOTAL 4 11 51\nUNIQUE 7\nTOP c 3\nTOP is 2\nTOP memory 2\nTOP and 1\nTOP fast 1\nTOP fun 1\nTOP matters 1\n';

test('report oracle uses approved ASCII word/line/byte/tie semantics', () => {
  const expectation = expectedReport(inputs);
  assert.deepEqual(expectation.total, [4, 11, 51]);
  assert.equal(expectation.unique, 7);
  assert.deepEqual(expectation.top.slice(0, 5), [
    { word: 'c', count: 3 }, { word: 'is', count: 2 }, { word: 'memory', count: 2 },
    { word: 'and', count: 1 }, { word: 'fast', count: 1 },
  ]);
  assert.equal(expectedReport([{path:'empty',text:''}]).files[0].lines, 0);
  assert.equal(expectedReport([{path:'last',text:'one'}]).files[0].lines, 1);
});

test('report verifies all semantics while accepting non-semantic whitespace and bound sandbox names', () => {
  assert(matchesReport(correct, expectedReport(inputs)));
  assert(matchesReport('\n ' + correct.replaceAll(' ', '\t').replace('"a.txt"', '"/snapshot/a.txt"') + '\n', expectedReport(inputs)));
  for (const wrong of [correct.replace('4 11 51', '4 11 52'), correct.replace('TOP c 3', 'TOP c 2'),
    correct.replace('TOP is 2\nTOP memory 2', 'TOP memory 2\nTOP is 2'),
    correct.replace('FILE "a.txt"', 'FILE "other/a.txt"'), correct.replace('UNIQUE 7', 'UNIQUE 8'),
    correct + 'TOTAL 4 11 51\n', correct.replace('TOP matters 1\n', ''), 'passed\n',
    correct.replace('FILE "b.txt" 1 3 14\n', ''), correct.replace('TOP c 3', 'TOP C 3')]) {
    assert.equal(matchesReport(wrong, expectedReport(inputs)), false, wrong);
  }
});

test('JSON path quoting preserves semantic spaces and escaped names', () => {
  const input = { path: 'a space".txt', text: '' };
  const report = `FILE ${JSON.stringify(input.path)} 0 0 0\nTOTAL 0 0 0\nUNIQUE 0\n`;
  assert(matchesReport(report, expectedReport([input])));
  assert.equal(matchesReport(report.replace('a space', 'a  space'), expectedReport([input])), false);
});
