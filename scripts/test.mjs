import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverTests, parseOptions, scheduleTestPhases, targetTasks, testUsage } from './test-discovery.mjs';
import { runVerification } from './test-scheduler.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
try {
  const options = parseOptions(process.argv.slice(2), 'test');
  if (options.help) console.log(testUsage);
  else {
    const files = discoverTests(root, options.target, options);
    console.log(`${options.target}: ${files.length} ${options.external ? 'external' : 'local'} test files discovered recursively.`);
    if (options.list) files.forEach(file => console.log(file));
    else {
      if (options.external) console.log('External tests require their documented runtime/provider/owner-sshd environment; existing environment gates remain in effect.');
      const tasks = targetTasks(root, options.target, files);
      const preparation = options.target === 'checks' ? [] : [[{
        name: 'build:test', command: process.execPath, args: ['scripts/build.mjs', `${options.target}:test`], group: 'build:test', cwd: root,
      }]];
      process.exitCode = await runVerification({ root, options, phases: [
        ...preparation,
        ...scheduleTestPhases(tasks),
      ] });
    }
  }
} catch (error) {
  console.error(`[test] ${error.message}`);
  process.exitCode = 1;
}
