export function readPort(value: string | undefined): number {
  if (value === undefined) return 3000;
  if (!/^[0-9]+$/.test(value)) throw new Error('PORT must be an integer from 1 to 65535.');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535.');
  }
  return port;
}

import { readFileSync,lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

function controlledFile(file:string) {
  if (!isAbsolute(file)) return false;
  try {
    const stat=lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink()
      && (process.platform==='win32' || (stat.mode & 0o022)===0);
  } catch { return false; }
}
const existingFile=z.string().refine(controlledFile);
const personalModelsSchema=z.strictObject({directory:z.string().refine(isAbsolute),callsEnabled:z.boolean().default(true)});
const allowedLoginUserIdsSchema=z.array(z.string().min(1).max(128)).min(1).max(20).refine(ids=>new Set(ids).size===ids.length);
export function readControlledJson(file:string):unknown {
  if (!controlledFile(file) || lstatSync(file).size>1024*1024) throw new Error('Controlled configuration file required.');
  return JSON.parse(readFileSync(file,'utf8'));
}

export const i0ConfigSchema=z.strictObject({
  synthetic:z.literal(true),databaseFile:existingFile,
  allowedLoginUserIds:allowedLoginUserIdsSchema.optional(),
  origin:z.url().refine(value=>value.startsWith('https://') && new URL(value).origin===value),
  tls:z.strictObject({keyFile:existingFile,certFile:existingFile}),signingSecretFile:existingFile,
  generationFile:existingFile.optional(),
  ssh:z.strictObject({binary:existingFile,keyFile:existingFile,knownHostsFile:existingFile,
    host:z.string().regex(/^[A-Za-z0-9.-]+$/),port:z.number().int().min(1).max(65535)}),
  staticDirectory:z.string().refine(value=>{
    try { return isAbsolute(value) && lstatSync(value).isDirectory() && !lstatSync(value).isSymbolicLink(); }
    catch { return false; }
  }),
  consumerIntervalMs:z.number().int().min(50).max(10000).default(250),
  personalModels:personalModelsSchema.optional(),
  tutoring:z.strictObject({
    apiKeyFile:existingFile.optional(),
    callsAuthorized:z.boolean().default(false),
    versions:z.strictObject({modelConfig:z.string().min(1).max(128),prompt:z.string().min(1).max(128),
      schema:z.string().min(1).max(128),policy:z.string().min(1).max(128)}),
  }).refine(value=>!value.callsAuthorized||!!value.apiKeyFile,'Authorized calls require an existing key file').optional(),
});
export function readI0Config(file:string) { return i0ConfigSchema.parse(readControlledJson(file)); }
export function readI0Generation(file:string|undefined) {
  if (!file) return '';
  const value=z.object({data:z.object({recoveryGeneration:z.string().min(1).max(128)})}).safeParse(readControlledJson(file));
  return value.success ? value.data.data.recoveryGeneration : '';
}
export function readI0SigningSecret(file:string) {
  if (!controlledFile(file) || lstatSync(file).size>4096) throw new Error('Controlled signing material required.');
  const secret=readFileSync(file,'utf8').trim();
  if (secret.length<32 || secret.length>4096) throw new Error('Invalid signing material.');
  return secret;
}

import { hdlRuntimeSchema } from '../../contracts/design/hdl.ts';
export const sshConfigurationSchema=i0ConfigSchema.shape.ssh;
const executionNodeSchema=z.strictObject({nodeId:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),label:z.string().min(1).max(128),
 recoveryGeneration:z.string().min(1).max(128),ssh:sshConfigurationSchema});
export const applicationConfigSchema=z.strictObject({databaseFile:existingFile,origin:i0ConfigSchema.shape.origin,
 allowedLoginUserIds:allowedLoginUserIdsSchema.optional(),
 tls:i0ConfigSchema.shape.tls,signingSecretFile:existingFile,ssh:sshConfigurationSchema.optional(),executionNodes:z.array(executionNodeSchema).min(1).max(16).optional(),legacyExecutionNodeId:z.string().min(1).max(64).optional(),
 approvedHdlRuntimes:z.array(hdlRuntimeSchema).min(1),recoveryGeneration:z.string().min(1).max(128),
 staticDirectory:i0ConfigSchema.shape.staticDirectory.optional(),consumerIntervalMs:i0ConfigSchema.shape.consumerIntervalMs,
 tutoring:i0ConfigSchema.shape.tutoring,personalModels:personalModelsSchema.optional(),review:z.strictObject({enabled:z.literal(true)}).optional()})
 .refine(value=>Boolean(value.ssh)!==Boolean(value.executionNodes),'Choose exactly one single-node or member-node configuration')
 .refine(value=>!value.executionNodes||new Set(value.executionNodes.map(node=>node.nodeId)).size===value.executionNodes.length,'Node IDs must be unique')
 .refine(value=>!value.legacyExecutionNodeId||value.executionNodes?.some(node=>node.nodeId===value.legacyExecutionNodeId),'Original node must be registered');
export function readApplicationConfig(file:string) { return applicationConfigSchema.parse(readControlledJson(file)); }
