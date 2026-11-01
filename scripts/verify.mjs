import { parseOptions, verificationPlan, verifyUsage } from './test-discovery.mjs';
import { runVerification } from './test-scheduler.mjs';

try {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) console.log(verifyUsage);
  else {
    const root = process.cwd();
    const phases = verificationPlan(root, options);
    if (options.list) {
      for (const phase of phases) for (const task of phase) console.log(`${task.group}: ${task.name}`);
    } else process.exitCode = await runVerification({ root, options, phases });
  }
} catch (error) {
  console.error(`[verify] ${error.message}`);
  process.exitCode = 1;
}
