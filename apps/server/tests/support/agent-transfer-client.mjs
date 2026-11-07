import { readFile, writeFile } from 'node:fs/promises';
import { createAgentConnection } from '../../../../packages/product-runtime/dist/agent-connections.js';
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const result = await createAgentConnection(input.root, input.connectionId, 'teaching.dependencies')(input.payload);
if (input.outputFile) await writeFile(input.outputFile, JSON.stringify(result));
