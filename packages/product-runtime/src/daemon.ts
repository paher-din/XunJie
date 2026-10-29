import { createProductRuntimeHost } from './host.js';

if (process.argv.length !== 4 || process.argv[2] !== '--root') throw new Error('Usage: daemon --root <product-environment>');
await createProductRuntimeHost({ root: process.argv[3]! }).catch(error => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
