import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { marked } from 'marked';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const excludedDirectories = new Set([
  '.git', 'node_modules', 'dist', 'coverage', 'test-results', 'playwright-report',
]);

function maintainedMarkdown(root, file) {
  const path = relative(root, file).split(sep).join('/');
  if (!/\.(md|markdown)$/i.test(path) || path.startsWith('../') || isAbsolute(path)) return false;
  if (path.startsWith('docs/archive/')) return false;
  if (path.split('/').some(part => excludedDirectories.has(part))) return false;
  if (/(?:^|\/)(?:tests?|__tests__)\/evidence\//.test(path)) return false;
  let current = root;
  for (const part of path.split('/')) {
    current = resolve(current, part);
    // Skill aliases must not cause reads outside the maintained tree.
    if (!existsSync(current)) return false; // Deleted tracked files are not inputs.
    if (lstatSync(current).isSymbolicLink()) return false;
  }
  return lstatSync(file).isFile();
}

function discover(root) {
  // Git bounds untracked discovery, so ignored caches are never traversed here.
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).split('\0').filter(Boolean).map(file => resolve(root, file));
}

function linksWithLines(source) {
  const links = [];
  let blockOffset = 0;
  for (const block of marked.lexer(source)) {
    let cursor = 0;
    let lastStart = 0;
    marked.walkTokens([block], token => {
      if (!['link', 'image', 'codespan', 'code'].includes(token.type)) return;
      let start = block.raw.indexOf(token.raw, cursor);
      // An image can be nested inside a link whose raw text we just consumed.
      if (start < 0) start = block.raw.indexOf(token.raw, lastStart);
      if (start < 0) start = block.raw.indexOf(token.raw.split('\n')[0], cursor);
      if (start < 0) start = 0;
      lastStart = start;
      cursor = Math.max(cursor, start + token.raw.length);
      if (token.type === 'link' || token.type === 'image') {
        links.push({ href: token.href, line: source.slice(0, blockOffset + start).split('\n').length });
      }
    });
    blockOffset += block.raw.length;
  }
  return links;
}

export function checkDocLinks({ root = repoRoot, files } = {}) {
  root = resolve(root);
  const candidates = files === undefined ? discover(root) : files.map(file => resolve(root, file));
  const selected = [...new Set(candidates)].filter(file => maintainedMarkdown(root, file)).sort();
  const failures = candidates.filter(file => files !== undefined && !existsSync(file))
    .map(file => `${relative(root, file)}:1: Markdown input does not exist`);
  let checked = 0;
  for (const file of selected) {
    const source = readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
    for (const { href, line } of linksWithLines(source)) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) continue;
      const path = href.split(/[?#]/, 1)[0];
      if (!path) continue;
      checked++;
      let target;
      try {
        target = resolve(dirname(file), decodeURIComponent(path));
      } catch {
        failures.push(`${relative(root, file)}:${line}: invalid percent encoding in local target ${JSON.stringify(href)}`);
        continue;
      }
      // Existence only: in particular, never open targets inside docs/archive/.
      if (!existsSync(target)) {
        failures.push(`${relative(root, file)}:${line}: missing local target ${JSON.stringify(href)} (${relative(root, target)})`);
      }
    }
  }
  return { files: selected.length, checked, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const files = process.argv.slice(2);
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const result = checkDocLinks({ root, files: files.length ? files.map(file => resolve(file)) : undefined });
    for (const failure of result.failures) console.error(failure);
    console.log(`doc-links: ${result.files} Markdown files, ${result.checked} local targets, ${result.failures.length} failures.`);
    process.exitCode = result.failures.length ? 1 : 0;
  } catch (error) {
    console.error(`doc-links: ${error.message}`);
    process.exitCode = 1;
  }
}
