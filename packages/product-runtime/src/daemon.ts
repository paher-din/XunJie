import { createProductRuntimeHost } from './host.js';
import { createProductLearningApplication } from './learning-entry.js';

if (process.argv.length !== 4 || process.argv[2] !== '--root') throw new Error('Usage: daemon --root <product-environment>');
await createProductRuntimeHost({ root: process.argv[3]!, createApplication: createProductLearningApplication }).catch(error => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
