import './check-runtime.mjs';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

if (process.exitCode) process.exit(process.exitCode);

const derive = promisify(scrypt);
const parameters = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
const syntheticInput = Buffer.alloc(32, 0xa5);
const keyLength = 64;
const saltLength = 16;
const round = (value) => Math.round(value * 100) / 100;
const delay = monitorEventLoopDelay({ resolution: 10 });
let peakSampledRss = process.memoryUsage().rss;
const sampling = setInterval(() => { peakSampledRss = Math.max(peakSampledRss, process.memoryUsage().rss); }, 10);

try {
  delay.enable();
  const durations = [];
  for (let index = 0; index < 5; index++) {
    const start = performance.now();
    await derive(syntheticInput, randomBytes(saltLength), keyLength, parameters);
    durations.push(round(performance.now() - start));
  }
  const start = performance.now();
  await Promise.all(Array.from({ length: 2 }, () => derive(syntheticInput, randomBytes(saltLength), keyLength, parameters)));
  const concurrentDuration = round(performance.now() - start);
  const salt = randomBytes(saltLength);
  const original = await derive(syntheticInput, salt, keyLength, parameters);
  const matched = await derive(syntheticInput, salt, keyLength, parameters);
  const different = await derive(Buffer.alloc(32, 0xa6), salt, keyLength, parameters);
  const checks = { equalInputMatches: timingSafeEqual(original, matched), differentInputRejected: !timingSafeEqual(original, different) };
  if (!checks.equalInputMatches || !checks.differentInputRejected) throw new Error('Synthetic check failed.');
  process.stdout.write(JSON.stringify({
    probe: 'A1 synthetic scrypt parameters; not login or NFR acceptance',
    runtime: process.version, platform: process.platform, arch: process.arch,
    parameters: { ...parameters, keyLength, saltLength },
    serialSamplesMs: durations, concurrentSamples: 2, concurrentBatchMs: concurrentDuration,
    peakSampledRssMiB: round(peakSampledRss / 1024 / 1024),
    sampledEventLoopP95Ms: round(delay.percentile(95) / 1e6), checks,
  }, null, 2) + '\n');
} catch {
  process.stderr.write('Synthetic scrypt probe failed; no input or derived value was logged.\n');
  process.exitCode = 1;
} finally {
  clearInterval(sampling);
  delay.disable();
}
