import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const taskPath = 'docs/tasks/A0_BUSINESS_CONTRACT_REVIEW.md';
const normalizePath = (value) => value.split(sep).join('/');

// Overrides support checking deliberately broken documents in memory. No files are written.
export function checkRepository(root = repositoryRoot, overrides = {}) {
  const errors = [];
  const read = (file) => overrides[file] ?? readFileSync(resolve(root, file), 'utf8');
  const documents = ['AGENTS.md', 'README.md', ...markdownFiles(root, 'docs')];
  const texts = new Map(documents.map((file) => [file, read(file)]));
  let internalLinks = 0;

  for (const [file, text] of texts) {
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (/^https?:\/\//i.test(target)) continue;
      internalLinks += 1;
      try {
        const [encodedName, fragment] = target.split('#');
        const name = decodeURIComponent(encodedName);
        if (/^(?:[a-z]:[\\/]|[\\/]|file:)/i.test(name)) {
          errors.push(`${file}: absolute document link ${target}`);
          continue;
        }
        const destination = name
          ? resolve(root, dirname(file), name)
          : resolve(root, file);
        const destinationPath = normalizePath(relative(root, destination));
        if (destinationPath === '..' || destinationPath.startsWith('../') || isAbsolute(destinationPath)) {
          errors.push(`${file}: document link escapes repository ${target}`);
          continue;
        }
        if (!existsSync(destination) || !statSync(destination).isFile()) {
          errors.push(`${file}: missing document ${target}`);
          continue;
        }
        if (fragment && !headingAnchors(read(destinationPath)).has(decodeURIComponent(fragment))) {
          errors.push(`${file}: missing heading ${target}`);
        }
      } catch (error) {
        errors.push(`${file}: cannot read link ${target}: ${error.message}`);
      }
    }
  }

  const task = texts.get(taskPath);
  if (!task) {
    return { check: 'A0 static document review', documents: documents.length, errors: ['Missing A0 task document'] };
  }
  const section = (heading) => {
    const lines = task.split(/\r?\n/);
    const start = lines.findIndex((line) => line.startsWith(heading));
    if (start < 0) {
      errors.push(`Missing section ${heading}`);
      return '';
    }
    const level = lines[start].match(/^#+/)[0].length;
    let end = start + 1;
    while (end < lines.length && !new RegExp(`^#{1,${level}} `).test(lines[end])) end += 1;
    return lines.slice(start + 1, end).join('\n');
  };
  const numberedRows = (heading, pattern, count, columns, label) => {
    const rows = section(heading).split('\n').filter((line) => pattern.test(line));
    const ids = rows.map((row) => row.match(pattern)[1]);
    if (rows.length !== count || new Set(ids).size !== count) errors.push(`${label}: incorrect count or duplicate ID`);
    for (let index = 1; index <= count; index += 1) {
      if (!ids.includes(String(index).padStart(2, '0'))) errors.push(`${label}: missing ${index}`);
    }
    for (const row of rows) {
      const cells = tableCells(row);
      if (cells.length !== columns || cells.some((cell) => !cell)) errors.push(`${label}: incomplete table row ${row}`);
    }
    return rows;
  };

  const commands = numberedRows('## 5.', /^\| CMD-(\d{2}) (?:POST|PATCH)/, 24, 5, 'commands');
  const recovery = numberedRows('### 5.1 ', /^\| CMD-(\d{2}) \|/, 24, 4, 'recovery');
  const reads = numberedRows('## 7.', /^\| READ-(\d{2}) /, 19, 4, 'reads');
  const parameters = numberedRows('### 10.1 ', /^\| A0-D(\d{2}) /, 12, 4, 'D-03');
  const cases = numberedRows('## 11.', /^\| A0-T(\d{2}) \|/, 20, 4, 'planned cases');
  const decisions = numberedRows('### 12.1 ', /^\| A0-R(\d{2}) \|/, 12, 4, 'decisions');
  const examples = numberedRows('## 16.', /^\| A0-E(\d{2}) /, 15, 3, 'synthetic examples');
  const trace = numberedRows('### 18.1 ', /^\| TRACE-(\d{2}) \|/, 20, 5, 'traceability');
  const handoff = numberedRows('### 18.2 ', /^\| HANDOFF-(\d{2}) \|/, 12, 4, 'handoff');
  const independent = numberedRows('### 18.3 ', /^\| A0-I(\d{2}) \|/, 8, 3, 'independent deliverables');

  const baseline = texts.get('docs/product/MVP_SPEC.md');
  const baselineIds = new Set([
    ...baseline.matchAll(/^### (M-\d{2}) /gm),
    ...baseline.matchAll(/^\| ((?:AC|NFR)-\d{2}) \|/gm),
  ].map((match) => match[1]));
  for (const row of trace) {
    const cells = tableCells(row);
    if (cells.length !== 5) continue;
    const number = cells[0].slice('TRACE-'.length);
    if (cells[1] !== `A0-T${number}`) errors.push(`Trace ${number}: mismatched planned case`);
    if (!/^M-\d{2}(?:, M-\d{2})*$/.test(cells[2])) errors.push(`Trace ${number}: invalid capability list`);
    if (!/^(?:AC|NFR)-\d{2}(?:, (?:AC|NFR)-\d{2})*$/.test(cells[3])) errors.push(`Trace ${number}: invalid acceptance list`);
    for (const id of [...cells[2].matchAll(/M-\d{2}/g), ...cells[3].matchAll(/(?:AC|NFR)-\d{2}/g)].map((match) => match[0])) {
      if (!baselineIds.has(id)) errors.push(`Trace ${number}: unknown baseline ID ${id}`);
    }
  }
  for (const row of handoff) {
    const cells = tableCells(row);
    if (cells.length !== 4) continue;
    if (cells[1] !== `A0-R${cells[0].slice('HANDOFF-'.length)}`) errors.push(`Handoff ${cells[0]}: mismatched decision`);
  }

  const fence = String.fromCharCode(96).repeat(3);
  const jsonBlocks = [...task.matchAll(new RegExp(fence + 'json\\s*([\\s\\S]*?)' + fence, 'g'))];
  for (let index = 0; index < jsonBlocks.length; index += 1) {
    try { JSON.parse(jsonBlocks[index][1]); }
    catch (error) { errors.push(`JSON example ${index + 1}: ${error.message}`); }
  }
  if (jsonBlocks.length !== 4) errors.push('Expected four JSON examples');

  const batches = [...section('### 15.2 ').matchAll(/^\| A1-P([1-3]) /gm)].map((match) => match[1]);
  if (batches.length !== 3 || new Set(batches).size !== 3) errors.push('Expected three first implementation batches');

  const technical = texts.get('docs/product/TECH_DESIGN.md');
  const baselineCommandSection = technical.split('## 5. ')[1]?.split('## 6. ')[0] ?? '';
  const baselineRoutes = routes(baselineCommandSection, ['POST', 'PATCH']);
  const proposedRoutes = routes(commands.join('\n'), ['POST', 'PATCH']);
  const missingBaselineRoutes = [...baselineRoutes].filter((route) => !proposedRoutes.has(route));
  errors.push(...missingBaselineRoutes.map((route) => `Baseline command omitted: ${route}`));
  const additionalRoutes = [...proposedRoutes].filter((route) => !baselineRoutes.has(route));
  const expectedAdditionalRoutes = new Set(['POST /api/attempts/:id/feedback', 'POST /api/blueprints/:id/rubric-trials']);
  for (const route of additionalRoutes) {
    if (!expectedAdditionalRoutes.has(route)) errors.push(`Undocumented command addition: ${route}`);
  }
  for (const route of expectedAdditionalRoutes) {
    if (!additionalRoutes.includes(route)) errors.push(`Missing proposed completion route: ${route}`);
  }

  for (const file of [taskPath, 'README.md']) {
    const text = texts.get(file);
    text.split(/\r?\n/).forEach((line, index) => {
      if (/[\t ]+$/.test(line)) errors.push(`${file}: trailing whitespace at line ${index + 1}`);
    });
    if (/^(?:<<<<<<<|=======|>>>>>>>)/m.test(text)) errors.push(`${file}: merge conflict marker`);
    if (/[A-Z]:[\\/]|file:\/\/|localhost:\d/.test(text)) errors.push(`${file}: local-only dependency`);
  }
  for (const status of ['未执行', '待授权维护者汇总', 'A0 未通过', 'G0 未冻结']) {
    if (!task.includes(status)) errors.push(`Missing qualification: ${status}`);
  }

  return {
    check: 'A0 static document review',
    documents: documents.length,
    internalLinks,
    commands: commands.length,
    recoveryRows: recovery.length,
    readGroups: reads.length,
    dataParameters: parameters.length,
    decisions: decisions.length,
    plannedCases: cases.length,
    syntheticExamples: examples.length,
    jsonExamples: jsonBlocks.length,
    traceabilityRows: trace.length,
    handoffQuestions: handoff.length,
    independentDeliverables: independent.length,
    firstBatches: batches.length,
    baselineMutationRoutes: baselineRoutes.size,
    additionalProposedRoutes: additionalRoutes,
    businessTests: 'NOT_EXECUTED',
    errors,
  };
}

function markdownFiles(root, directory) {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return markdownFiles(root, file);
    return entry.name.endsWith('.md') ? [file] : [];
  });
}

function headingAnchors(text) {
  const seen = new Map();
  return new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => {
    const anchor = match[1].trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const duplicates = seen.get(anchor) ?? 0;
    seen.set(anchor, duplicates + 1);
    return anchor + (duplicates ? `-${duplicates}` : '');
  }));
}

function tableCells(row) {
  return row.split('|').slice(1, -1).map((cell) => cell.trim());
}

function routes(text, methods) {
  const pattern = new RegExp(`(?:${methods.join('|')}) /api/[^\\s；|]+`, 'g');
  return new Set([...text.matchAll(pattern)].map((match) => match[0]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkRepository();
    console.log(JSON.stringify(result, null, 2));
    if (result.errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(`A0 document check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
