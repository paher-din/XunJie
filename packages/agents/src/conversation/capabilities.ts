import { StorageError } from '@xunjie/storage';
import { canonicalDigest } from '@xunjie/storage/identity';
import type { ConversationToolBinding, ConversationToolContext, ConversationToolModule } from './tools.js';
import { createToolResults, projectToolOutcome } from '../capabilities/tool-discovery/tool-results.ts';

/** Installed modules determine executable bindings. A model name never selects code. */
export function createConversationCapabilities(tools: readonly ConversationToolModule[]) {
  const originals = new Map(tools.map(module => [module.id, module]));
  if (originals.size !== tools.length || originals.has('tool-results')) throw new StorageError('identity-conflict');
  const installed = [...tools, ...(tools.length ? [createToolResults(originals)] : [])].map((module): ConversationToolModule => ({
    ...module, get id() { return module.id; }, get version() { return module.version; },
    async dispatch(context, command, permit, assertDispatch) {
      return projectToolOutcome(await module.dispatch(context, command, permit, assertDispatch), command.commandId);
    },
    async reconcile(context, command) {
      const result = await module.reconcile(context, command);
      return result ? projectToolOutcome(result, command.commandId) : null;
    },
    ...(module.stop ? { async stop(context, command) {
      const result = await module.stop!(context, command);
      return result ? projectToolOutcome(result, command.commandId) : null;
    } } : {}),
  }));
  const modules = new Map(installed.map(module => [module.id, module]));
  async function bindings(context: ConversationToolContext): Promise<ConversationToolBinding[]> {
    const offered = (await Promise.all(installed.map(async module => (await module.list(context)).map(offer => ({
      ...offer, moduleId: module.id, moduleVersion: module.version, bindingId: canonicalDigest({ moduleId: module.id, version: module.version, offer }),
    }))))).flat();
    if (offered.length > 64) throw new StorageError('invalid');
    const ids = new Set<string>();
    return offered.map(binding => {
      if (ids.has(binding.bindingId)) throw new StorageError('identity-conflict');
      ids.add(binding.bindingId);
      const modelName = offered.filter(other => other.definition.name === binding.definition.name).length > 1
        ? binding.definition.name.slice(0, 46) + '_' + binding.bindingId.slice(0, 16) : binding.definition.name;
      return { ...binding, modelName };
    });
  }
  return { modules, bindings };
}
