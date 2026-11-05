#!/usr/bin/env node
/** #188: freeze the public component bytes once in the workspace for a client device probe. */
import { writeFile } from 'node:fs/promises';
import { annotationPackage } from '../components/material-annotation/package.mjs';
import { aggregationPackage } from '../components/table-aggregation/package.mjs';
import { accumulatorPackage } from '../components/state-accumulator/package.mjs';
const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/freeze-component-definitions.mjs <out.json>');
const definitions = [await annotationPackage(), await aggregationPackage(), await accumulatorPackage()];
await writeFile(out, JSON.stringify(definitions) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ out, digests: definitions.map(d => d.manifest.entry.sha256) }));
