import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../packages/ui/src/assets/brand/sprout/', import.meta.url));
const subject = JSON.parse(readFileSync(join(root, 'registration.json'), 'utf8')).poses.none;
writeFileSync(join(root, 'runtime-subject.json'), JSON.stringify({ source: subject.source, mask: subject.mask }) + '\n');
const sources = ['master', 'rig/underpaint-v1', ...['chalk', 'glasses', 'pencil', 'pointer'].map(name => `accessories/${name}-v1`)];
for (const source of sources) {
  for (const compact of [false, true]) {
    const output = join(root, compact ? 'compact' : '', source + '.webp');
    mkdirSync(dirname(output), { recursive: true });
    const result = spawnSync('cwebp', ['-quiet', '-lossless', '-exact', '-m', '6',
      ...(compact ? ['-resize', '256', '0'] : []), join(root, source + '.png'), '-o', output], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
