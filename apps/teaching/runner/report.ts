import { Buffer } from 'node:buffer';

export type FileStatistics = { path: string; lines: number; words: number; bytes: number };
export type ReportExpectation = { files: FileStatistics[]; total: [number, number, number];
  unique: number; top: { word: string; count: number }[] };

export function wordFrequency(texts: string[]) {
  const counts = new Map<string, number>();
  for (const text of texts) for (const word of text.match(/[A-Za-z0-9]+/g) ?? []) {
    const normalized = word.toLowerCase();
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return [...counts].map(([word,count])=>({word,count}))
    .sort((a,b)=>b.count-a.count||(a.word<b.word?-1:a.word>b.word?1:0));
}

export function expectedReport(inputs: { path: string; text: string }[]): ReportExpectation {
  const counts = new Map<string, number>();
  const files = inputs.map(({ path, text }) => {
    const words = text.match(/[A-Za-z0-9]+/g) ?? [];
    for (const word of words) {
      const normalized = word.toLowerCase();
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
    return { path, lines: (text.match(/\n/g)?.length ?? 0) + (text && !text.endsWith('\n') ? 1 : 0),
      words: words.length, bytes: Buffer.byteLength(text) };
  });
  const total: [number, number, number] = [0, 0, 0];
  for (const file of files) { total[0] += file.lines; total[1] += file.words; total[2] += file.bytes; }
  return { files, total, unique: counts.size,
    top: [...counts].map(([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0)).slice(0, 10) };
}

export function matchesReport(text: string, expected: ReportExpectation): boolean {
  const files = new Map<string, [number, number, number]>();
  let total: number[] | undefined;
  let unique: number | undefined;
  const top: { word: string; count: number }[] = [];
  const quotedPath = '"(?:[^"\\\\\u0000-\u001f]|\\\\["\\\\/bfnrt]|\\\\u[0-9a-fA-F]{4})*"';
  const filePattern = new RegExp(`^FILE\\s+(${quotedPath})\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)$`);
  const numbers = (values: string[]) => {
    const parsed = values.map(Number);
    return parsed.every(value => Number.isSafeInteger(value) && value >= 0) ? parsed : undefined;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const file = line.match(filePattern);
    if (file) {
      let path: string;
      try { path = JSON.parse(file[1]!); } catch { return false; }
      if (path.startsWith('/snapshot/')) path = path.slice('/snapshot/'.length);
      const values = numbers(file.slice(2));
      if (!values || files.has(path) || !expected.files.some(file => file.path === path)) return false;
      files.set(path, [values[0]!, values[1]!, values[2]!]);
      continue;
    }
    const totalRow = line.match(/^TOTAL\s+(\d+)\s+(\d+)\s+(\d+)$/);
    if (totalRow) { if (total) return false; total = numbers(totalRow.slice(1)); if (!total) return false; continue; }
    const uniqueRow = line.match(/^UNIQUE\s+(\d+)$/);
    if (uniqueRow) { if (unique !== undefined) return false; unique = numbers([uniqueRow[1]!])?.[0]; if (unique === undefined) return false; continue; }
    const topRow = line.match(/^TOP\s+([a-z0-9]+)\s+(\d+)$/);
    if (!topRow) return false;
    const count = numbers([topRow[2]!])?.[0];
    if (!count || top.some(item => item.word === topRow[1])) return false;
    top.push({ word: topRow[1]!, count });
  }
  return files.size === expected.files.length && expected.files.every(file => {
    const actual = files.get(file.path);
    return actual?.[0] === file.lines && actual[1] === file.words && actual[2] === file.bytes;
  }) && total?.every((value, index) => value === expected.total[index]) === true
    && unique === expected.unique && JSON.stringify(top) === JSON.stringify(expected.top);
}
