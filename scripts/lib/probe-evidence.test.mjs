import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const helper = new URL('./probe-evidence.mjs', import.meta.url).href;
const imports = `
  import assert from 'node:assert/strict';
  import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { tmpdir } from 'node:os';
  import { probeEvidenceDirectory, writeEvidence, captureEvidence, captureJobEvidence, mkdtemp } from ${JSON.stringify(helper)};
  process.argv = [process.execPath, 'probe-fixture', ...process.argv.slice(1)];
`;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'xj-probe-evidence-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function child(source, args = [], status = 0) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', imports + source, '--', ...args], { encoding: 'utf8' });
  assert.equal(result.status, status, result.stderr);
  return JSON.parse(result.stdout);
}

test('default checks consume temporary inputs without creating diagnostic files or capturing', t => {
  const marker = join(fixture(t), 'capture-called');
  const { directory, work } = child(`
    const directory = probeEvidenceDirectory();
    const work = await mkdtemp(join(tmpdir(), 'xj-probe-consumed-input-'));
    writeFileSync(join(work, 'input.json'), JSON.stringify({ expected: 42 }));
    assert.equal(JSON.parse(readFileSync(join(work, 'input.json'))).expected, 42);
    await writeEvidence(join(directory, 'report.json'), 'unused-report');
    await writeEvidence(join(directory, 'native.log'), 'unused-log');
    await captureEvidence({ screenshot() { writeFileSync(${JSON.stringify(marker)}, 'called'); } }, { path: join(directory, 'shot.png') });
    // Check before exit, so writing a report and later deleting it cannot pass.
    for (const name of ['report.json', 'native.log', 'shot.png']) assert.equal(existsSync(join(directory, name)), false);
    console.log(JSON.stringify({ directory, work }));
  `);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(directory), false);
  assert.equal(existsSync(work), false);
});

test('explicit output retains actual report and screenshot callback bytes', t => {
  const directory = join(fixture(t), 'evidence');
  child(`
    const directory = probeEvidenceDirectory(); mkdirSync(directory);
    await writeEvidence(join(directory, 'report.json'), JSON.stringify({ status: 'passed' }));
    await captureEvidence({ screenshot(options) { writeFileSync(options.path, 'screenshot-bytes'); } }, { path: join(directory, 'shot.png') });
    console.log(JSON.stringify({ directory }));
  `, ['--out', directory]);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'report.json'))), { status: 'passed' });
  assert.equal(readFileSync(join(directory, 'shot.png'), 'utf8'), 'screenshot-bytes');
});

test('explicit process.exit cleans owned working inputs as well as the default evidence directory', () => {
  const { directory, work } = child(`
    const directory = probeEvidenceDirectory();
    const work = await mkdtemp(join(tmpdir(), 'xj-probe-exit-input-'));
    writeFileSync(join(work, 'input.json'), '{}');
    assert.deepEqual(JSON.parse(readFileSync(join(work, 'input.json'))), {});
    console.log(JSON.stringify({ directory, work })); process.exit(7);
  `, [], 7);
  assert.equal(existsSync(directory), false);
  assert.equal(existsSync(work), false);
});

test('--out stays the primary output when an explicit evidence directory is also present', t => {
  const root = fixture(t), output = join(root, 'original'), evidence = join(root, 'document-consumer');
  for (const args of [['--evidence-dir', evidence, '--out', output], ['--out=' + output, '--evidence-dir=' + evidence]]) {
    const actual = child(`console.log(JSON.stringify({ directory: probeEvidenceDirectory() }));`, args);
    assert.equal(actual.directory, output);
  }
});

test('worker protocol --out does not authorize PNG capture when the job disables evidence', t => {
  const root = fixture(t);
  for (const mode of ['disabled', 'enabled', 'legacy-explicit-job']) {
    const output = join(root, mode + '-result.json'), image = join(root, mode + '.png');
    const marker = join(root, mode + '-capture-called'), jobPath = join(root, mode + '-job.json');
    const job = { screenshot: image, ...(mode === 'legacy-explicit-job' ? {} : { captureEvidence: mode === 'enabled' }) };
    child(`
      writeFileSync(${JSON.stringify(jobPath)}, JSON.stringify(${JSON.stringify(job)}));
      const job = JSON.parse(readFileSync(${JSON.stringify(jobPath)}));
      const result = { status: 'actual-checked', screenshots: [] };
      await captureJobEvidence(job, { screenshot(options) {
        writeFileSync(${JSON.stringify(marker)}, 'called');
        writeFileSync(options.path, 'actual-screenshot-bytes');
      } }, result, 'checked');
      assert.equal(existsSync(job.screenshot), ${mode !== 'disabled'});
      writeFileSync(${JSON.stringify(output)}, JSON.stringify(result));
      console.log(JSON.stringify({ status: result.status }));
    `, ['--out', output]);
    // This JSON is the controller's actual input, even when PNG capture is disabled.
    const result = JSON.parse(readFileSync(output));
    assert.equal(result.status, 'actual-checked');
    assert.equal(existsSync(marker), mode !== 'disabled');
    assert.equal(existsSync(image), mode !== 'disabled');
    assert.equal(result.screenshots.length, mode === 'disabled' ? 0 : 1);
    if (mode !== 'disabled') assert.equal(readFileSync(image, 'utf8'), 'actual-screenshot-bytes');
  }
});
