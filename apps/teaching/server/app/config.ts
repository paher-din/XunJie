export function readPort(value: string | undefined): number {
  if (value === undefined) return 3000;
  if (!/^[0-9]+$/.test(value)) throw new Error('PORT must be an integer from 1 to 65535.');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535.');
  }
  return port;
}

// External controlled configuration only: never write .env, certificates or SSH material.
import {readFileSync,statSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {z} from 'zod';
import {hdlRuntimeSchema} from '../../contracts/design/hdl.ts';
const existingFile=z.string().refine(value=>isAbsolute(value)&&statSync(value).isFile());
export const sshConfigurationSchema=z.strictObject({binary:existingFile,keyFile:existingFile,knownHostsFile:existingFile,host:z.string().regex(/^[A-Za-z0-9.-]+$/),port:z.number().int().min(1).max(65535)});
export const applicationConfigSchema=z.strictObject({databaseFile:existingFile,origin:z.url().refine(value=>value.startsWith('https://')&&new URL(value).origin===value),
 tls:z.strictObject({keyFile:existingFile,certFile:existingFile}),signingSecretFile:existingFile,
 ssh:sshConfigurationSchema,
 approvedHdlRuntimes:z.array(hdlRuntimeSchema).min(1),recoveryGeneration:z.string().min(1).max(128),consumerIntervalMs:z.number().int().min(50).max(10000).default(250)});
export function readControlledJson(file:string):unknown{if(!isAbsolute(file)||!statSync(file).isFile()||statSync(file).size>1024*1024)throw new Error('Controlled configuration file required.');return JSON.parse(readFileSync(file,'utf8'));}
export function readApplicationConfig(file:string){return applicationConfigSchema.parse(readControlledJson(file));}
