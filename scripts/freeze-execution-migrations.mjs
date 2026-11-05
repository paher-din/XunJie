#!/usr/bin/env node
/**
 * Freeze the shipped learning-data migrations for client devices that have no workspace source.
 * The bytes are public product schema definitions; the client probe feeds them to the packaged
 * `@xunjie/storage` implementation so every read/write still goes through product code.
 *
 * Usage: node scripts/freeze-execution-migrations.mjs <OUTPUT.json>
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = resolve(process.argv[2] ?? '.verification/wp03-188/private/learning-migrations.json');
const { learningMigrations } = await import(pathToFileURL(resolve('packages/learning-space/dist/index.js')).href);
if (!Array.isArray(learningMigrations) || learningMigrations.length < 1
  || learningMigrations.some(item => typeof item.version !== 'number' || typeof item.sql !== 'string'))
  throw new Error('The packaged learning migrations are not a plain serializable migration set.');
const bytes = JSON.stringify(learningMigrations) + '\n';
await writeFile(out, bytes, { mode: 0o600, flag: 'wx' });
console.log('LEARNING_MIGRATIONS ' + learningMigrations.length +
  ' SHA256 ' + createHash('sha256').update(bytes).digest('hex') + ' ' + out);
