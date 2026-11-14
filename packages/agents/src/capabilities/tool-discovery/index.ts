import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { canonicalDigest } from '@xunjie/storage/identity';
import { modelToolSchema } from '@xunjie/contracts/model-connections';
import type { AgentWait } from '@xunjie/contracts/agent-runtime';
import type { Facts } from '@xunjie/agent-runtime';
import type { ConversationToolModule, ConversationToolContext, ConversationToolOffer, ConversationPreparedTool,
  ConversationToolOutcome } from '../../conversation/tools.js';

const id = 'tool-discovery', version = 1, limit = 8192, maxPages = 8;
const json = (value: unknown): Facts => z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(value)));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema = z.object({ sessionId: z.uuid(), subjectDigest: hash }).strict();
const querySchema = z.object({ purpose: z.string().max(200).nullable().default(null), source: z.string().max(200).nullable().default(null),
  object: z.string().max(200).nullable().default(null), pageSize: z.number().int().min(1).max(8).default(4),
  cursor: z.string().max(1000).nullable().default(null) }).strict();
const loadSchema = z.object({ bindingIds: z.array(hash).min(1).max(8).refine(ids => new Set(ids).size === ids.length, 'Duplicate binding') }).strict();
const effect = z.enum(['read', 'write', 'execute', 'ask']);
const offerSchema = z.object({ definition: modelToolSchema, effect, scope: z.record(z.string(), z.json()) }).strict();
const bindingSchema = z.object({ bindingId: hash, moduleId: z.string().min(1).max(200), moduleVersion: z.number().int().positive(),
  modelName: modelToolSchema.shape.name, offer: offerSchema }).strict();
export type ToolDiscoveryBinding = z.infer<typeof bindingSchema>;
export interface ToolDiscoveryOptions {
  /** Install this composition alone in the pipeline; do not also install these raw modules. */
  modules: readonly ConversationToolModule[];
  /** Host decision, never a model choice. Default: only discover_tools/load_tools are initially visible. */
  initiallyVisible?(binding: ToolDiscoveryBinding, context: ConversationToolContext): boolean | Promise<boolean>;
}
const preparedSchema = z.object({ commandId: z.uuid(), name: z.string(), effect, input: z.record(z.string(), z.json()) }).strict();
const controlInput = z.object({ moduleId: z.literal(id), moduleVersion: z.literal(version), scope: scopeSchema,
  kind: z.enum(['discover', 'load']), catalogVersion: hash, arguments: z.record(z.string(), z.json()) }).strict();
const delegateInput = z.object({ moduleId: z.literal(id), moduleVersion: z.literal(version), scope: scopeSchema,
  kind: z.literal('delegate'), binding: bindingSchema, command: preparedSchema }).strict();
const envelope = z.discriminatedUnion('kind', [controlInput.extend({ kind: z.literal('discover') }),
  controlInput.extend({ kind: z.literal('load') }), delegateInput]);
const selectionSchema = bindingSchema.omit({ offer: true }).extend({ name: modelToolSchema.shape.name, scopeDigest: hash }).strict();
const entrySchema = selectionSchema.extend({ description: z.string().max(400) }).strict();
const receiptSchema = z.object({ moduleId: z.literal(id), moduleVersion: z.literal(version), commandId: z.uuid(), scope: scopeSchema,
  kind: z.enum(['discover', 'load']), catalogVersion: hash }).strict();
const controls = [
  { name: 'discover_tools', description: '分页发现当前宿主已批准的固定工具绑定。目录只供选择，不授予执行权限。', schema: querySchema },
  { name: 'load_tools', description: '加载已结算 discover_tools 回执中的固定 bindingIds；本次 native pair 闭合后才在下一步可见。不按同名替换。', schema: loadSchema },
] as const;
const controlDefinitions = controls.map(({ schema, ...definition }) => ({ ...definition, inputSchema: z.toJSONSchema(schema, { io: 'input' }) }));
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function success(result: Facts): ConversationToolOutcome {
  const text = JSON.stringify(result);
  if (text.length > limit || bytes(result) > limit) throw new StorageError('invalid');
  return { state: 'completed', feedback: { outcome: 'success', text, images: [] }, result };
}
function failure(error: unknown): ConversationToolOutcome {
  if (!(error instanceof StorageError) && !(error instanceof z.ZodError)) throw error;
  const reason = error instanceof StorageError ? error.code : 'invalid';
  return { state: 'failed', feedback: { outcome: 'error', text: '固定工具来源不可用：' + reason, images: [] }, result: { reason } };
}
function scopeOf(context: ConversationToolContext) {
  const { environmentId, spaceId, principalId, kind } = context.snapshot.session.identity;
  return { sessionId: context.snapshot.session.sessionId, subjectDigest: canonicalDigest({ environmentId, spaceId, principalId, kind }) };
}
const same = (a: unknown, b: unknown) => canonicalDigest(a) === canonicalDigest(b);
const selection = (binding: ToolDiscoveryBinding) => ({ bindingId: binding.bindingId, moduleId: binding.moduleId,
  moduleVersion: binding.moduleVersion, modelName: binding.modelName, name: binding.offer.definition.name, scopeDigest: canonicalDigest(binding.offer.scope) });
const originalBindingId = (binding: Pick<ToolDiscoveryBinding, 'moduleId' | 'moduleVersion' | 'offer'>) =>
  canonicalDigest({ moduleId: binding.moduleId, version: binding.moduleVersion, offer: binding.offer });

/** Reads only generic committed core facts and the installed modules' public ports. No storage or polling. */
export function createToolDiscovery(options: ToolDiscoveryOptions): ConversationToolModule {
  const installed = options.modules.map(module => ({ module, installedId: module.id }));
  if (new Set(installed.map(item => item.installedId)).size !== installed.length || installed.some(item => item.installedId === id))
    throw new StorageError('identity-conflict');
  function controlOffer(name: string, scope: z.infer<typeof scopeSchema>, catalogVersion: string): ConversationToolOffer {
    const definition = controlDefinitions.find(item => item.name === name);
    if (!definition) throw new StorageError('invalid');
    return { definition, effect: 'read', scope: json({ ...scope, kind: 'tool-discovery', catalogVersion }) };
  }
  function delegatedOffer(binding: ToolDiscoveryBinding, scope: z.infer<typeof scopeSchema>): ConversationToolOffer {
    return { definition: { ...binding.offer.definition, name: binding.modelName }, effect: binding.offer.effect,
      scope: json({ ...scope, kind: 'discovered-tool', bindingId: binding.bindingId, moduleId: binding.moduleId, moduleVersion: binding.moduleVersion }) };
  }
  async function catalog(context: ConversationToolContext) {
    const candidates: ToolDiscoveryBinding[] = [];
    // The host's explicit module order is stable; an owner failure is never silently an empty directory.
    for (const { module, installedId } of installed) {
      if (module.id !== installedId) throw new StorageError('incompatible');
      z.string().min(1).max(200).parse(module.id); z.number().int().positive().parse(module.version);
      for (const value of await module.list(context)) {
        const offer = offerSchema.parse(value);
        if (controls.some(control => control.name === offer.definition.name)) throw new StorageError('identity-conflict');
        const basis = { moduleId: module.id, moduleVersion: module.version, offer };
        candidates.push({ ...basis, bindingId: originalBindingId(basis), modelName: offer.definition.name });
      }
    }
    if (candidates.length > 512 || bytes(candidates) > 2_000_000) throw new StorageError('invalid');
    const keys = new Set<string>();
    for (const binding of candidates) {
      if (keys.has(binding.bindingId)) throw new StorageError('identity-conflict'); keys.add(binding.bindingId);
      if (candidates.filter(other => other.offer.definition.name === binding.offer.definition.name).length > 1)
        binding.modelName = binding.offer.definition.name.slice(0, 46) + '_' + binding.bindingId.slice(0, 16);
    }
    if (new Set(candidates.map(binding => binding.modelName)).size !== candidates.length) throw new StorageError('identity-conflict');
    candidates.sort((a, b) => a.bindingId.localeCompare(b.bindingId, 'en'));
    const scope = scopeOf(context);
    return { candidates, scope, catalogVersion: canonicalDigest({ scope, candidates }) };
  }
  function fixed(context: ConversationToolContext, command: ConversationPreparedTool) {
    const input = envelope.parse(command.input);
    if (!same(input.scope, scopeOf(context))) throw new StorageError('forbidden');
    if (input.kind === 'delegate') {
      if (input.binding.bindingId !== originalBindingId(input.binding) || command.name !== input.binding.modelName
        || command.effect !== input.binding.offer.effect || input.command.commandId !== command.commandId
        || input.command.name !== input.binding.offer.definition.name || input.command.effect !== command.effect) throw new StorageError('identity-conflict');
    } else if (command.effect !== 'read' || command.name !== (input.kind === 'discover' ? 'discover_tools' : 'load_tools')) throw new StorageError('invalid');
    return input;
  }
  function installedModule(binding: ToolDiscoveryBinding) {
    const item = installed.find(item => item.installedId === binding.moduleId);
    if (!item || item.module.id !== binding.moduleId || item.module.version !== binding.moduleVersion) throw new StorageError('incompatible');
    return item.module;
  }
  function validReceipt(context: ConversationToolContext, name: unknown, commandId: unknown, result: unknown) {
    if (name !== 'discover_tools' && name !== 'load_tools' || !result || typeof result !== 'object') return null;
    const facts = result as Facts, parsed = receiptSchema.safeParse(facts.receipt);
    if (!parsed.success || parsed.data.commandId !== commandId || !same(parsed.data.scope, scopeOf(context))
      || parsed.data.kind !== (name === 'discover_tools' ? 'discover' : 'load')) return null;
    if (parsed.data.kind === 'discover') {
      if (!Array.isArray(facts.entries) || !facts.entries.every(item => entrySchema.safeParse(item).success)) return null;
    } else if (!Array.isArray(facts.selections) || !facts.selections.every(item => selectionSchema.safeParse(item).success)) return null;
    return { receipt: parsed.data, result: facts };
  }
  function pairedReceipts(context: ConversationToolContext) {
    const receipts: { receipt: z.infer<typeof receiptSchema>; result: Facts }[] = [], known = new Set<string>();
    for (const step of context.snapshot.steps) {
      if (step.operation.kind !== 'model.tools.settle' || step.state !== 'completed' || step.result?.state !== 'completed') continue;
      const commands = step.snapshot.commands;
      if (!Array.isArray(commands)) continue;
      for (const raw of commands) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const binding = raw.binding as Facts | undefined, command = raw.command as Facts | undefined, outcome = raw.outcome as Facts | undefined;
        if (binding?.moduleId !== id || binding.moduleVersion !== version || outcome?.state !== 'completed' || !command) continue;
        const parsed = validReceipt(context, command.name, command.commandId, outcome.result);
        if (!parsed) continue;
        const offer = controlOffer(String(command.name), parsed.receipt.scope, parsed.receipt.catalogVersion);
        if (binding.bindingId !== canonicalDigest({ moduleId: id, version, offer })) continue;
        receipts.push(parsed); known.add(parsed.receipt.commandId);
      }
    }
    // Generic effects are written atomically with native pair settlement. Older unbound effects are not grants.
    for (const raw of Array.isArray(context.snapshot.sessionState.effects) ? context.snapshot.sessionState.effects : []) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.moduleId !== id || raw.moduleVersion !== version
        || raw.state !== 'completed' || raw.outcome !== 'success' || typeof raw.text !== 'string' || known.has(String(raw.commandId))) continue;
      let result: unknown; try { result = JSON.parse(raw.text); } catch { continue; }
      const parsed = validReceipt(context, raw.name, raw.commandId, result);
      if (!parsed || raw.resultDigest !== canonicalDigest(parsed.result)) continue;
      const offer = controlOffer(String(raw.name), parsed.receipt.scope, parsed.receipt.catalogVersion);
      if (raw.bindingId !== canonicalDigest({ moduleId: id, version, offer })) continue;
      receipts.push(parsed); known.add(parsed.receipt.commandId);
    }
    return receipts;
  }
  function loaded(context: ConversationToolContext) {
    const pins = new Map<string, z.infer<typeof selectionSchema>>();
    for (const item of pairedReceipts(context)) if (item.receipt.kind === 'load')
      for (const raw of item.result.selections as Facts[]) { const pin = selectionSchema.parse(raw); pins.set(pin.moduleId + ':' + pin.name, pin); }
    return [...pins.values()];
  }
  async function visible(context: ConversationToolContext, current: Awaited<ReturnType<typeof catalog>>) {
    const pins = loaded(context), result: ToolDiscoveryBinding[] = [];
    for (const binding of current.candidates) {
      const stale = pins.some(pin => pin.moduleId === binding.moduleId && pin.name === binding.offer.definition.name && pin.bindingId !== binding.bindingId);
      if (pins.some(pin => same(pin, selection(binding))) || !stale && await options.initiallyVisible?.(binding, context)) result.push(binding);
    }
    if (result.length > 62) throw new StorageError('invalid');
    return result;
  }
  function discovered(context: ConversationToolContext, catalogVersion: string) {
    return pairedReceipts(context).filter(item => item.receipt.kind === 'discover' && item.receipt.catalogVersion === catalogVersion)
      .flatMap(item => item.result.entries as Facts[]).map(item => { const { description: _description, ...pin } = entrySchema.parse(item); return selectionSchema.parse(pin); });
  }
  function page(current: Awaited<ReturnType<typeof catalog>>, args: z.infer<typeof querySchema>, receipt: z.infer<typeof receiptSchema>) {
    const { cursor: _cursor, ...query } = args;
    const candidates = current.candidates.filter(binding => (!query.purpose || (binding.offer.definition.name + '\n' + binding.offer.definition.description).toLocaleLowerCase().includes(query.purpose.toLocaleLowerCase()))
      && (!query.source || (binding.moduleId + '\n' + JSON.stringify(binding.offer.scope)).includes(query.source))
      && (!query.object || JSON.stringify(binding.offer.scope).includes(query.object)));
    const queryVersion = canonicalDigest({ catalogVersion: current.catalogVersion, query });
    let offset = 0, index = 0;
    if (args.cursor) {
      let raw: unknown; try { raw = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8')); } catch { throw new StorageError('invalid'); }
      const saved = z.object({ version: hash, offset: z.number().int().nonnegative(), page: z.number().int().min(0).max(maxPages - 1) }).strict().parse(raw);
      if (saved.version !== queryVersion) throw new StorageError('identity-conflict'); offset = saved.offset; index = saved.page;
    }
    const entriesAt = (start: number) => {
      const entries: Facts[] = [];
      for (const binding of candidates.slice(start, start + query.pageSize)) {
        const entry = json({ ...selection(binding), description: binding.offer.definition.description.slice(0, 400) });
        if (bytes([...entries, entry]) > 5800) { if (!entries.length) throw new StorageError('invalid'); break; }
        entries.push(entry);
      }
      return entries;
    };
    let expected = 0;
    for (let n = 0; n < index; n++) {
      const count = entriesAt(expected).length;
      if (!count || expected + count >= candidates.length) throw new StorageError('invalid'); expected += count;
    }
    if (offset !== expected) throw new StorageError('invalid');
    const entries = entriesAt(offset), next = offset + entries.length, hasMore = next < candidates.length, limitReached = hasMore && index === maxPages - 1;
    return json({ receipt, catalogVersion: current.catalogVersion, entries, offset, page: index + 1, maxPages,
      hasMore, limitReached, nextCursor: hasMore && !limitReached ? Buffer.from(JSON.stringify({ version: queryVersion, offset: next, page: index + 1 })).toString('base64url') : null,
      grantsExecution: false });
  }
  async function evaluate(context: ConversationToolContext, command: ConversationPreparedTool) {
    const input = fixed(context, command);
    if (input.kind === 'delegate') throw new StorageError('invalid');
    const current = await catalog(context);
    if (current.catalogVersion !== input.catalogVersion) throw new StorageError('identity-conflict');
    const receipt = { moduleId: id, moduleVersion: version, commandId: command.commandId, scope: input.scope,
      kind: input.kind, catalogVersion: input.catalogVersion } as const;
    if (input.kind === 'discover') return success(page(current, querySchema.parse(input.arguments), receipt));
    const args = loadSchema.parse(input.arguments), prior = discovered(context, input.catalogVersion);
    if (args.bindingIds.some(bindingId => !prior.some(entry => entry.bindingId === bindingId))) throw new StorageError('forbidden');
    const selections = args.bindingIds.map(bindingId => {
      const binding = current.candidates.find(item => item.bindingId === bindingId);
      if (!binding || !prior.some(pin => same(pin, selection(binding)))) throw new StorageError('identity-conflict'); return selection(binding);
    });
    const effective = new Map(loaded(context).map(pin => [pin.moduleId + ':' + pin.name, pin]));
    for (const pin of selections) effective.set(pin.moduleId + ':' + pin.name, pin);
    if (effective.size > 32) throw new StorageError('invalid');
    return success(json({ receipt, selections, effective: 'next-step-after-pair', grantsExecution: false }));
  }
  function routed(value: ConversationToolOutcome, input: z.infer<typeof delegateInput>, commandId: string): ConversationToolOutcome {
    let outcome = value;
    const { binding } = input;
    if (outcome.nextCommand) {
      const next = preparedSchema.parse(outcome.nextCommand);
      if (next.commandId === commandId || next.name !== input.command.name || next.effect !== input.command.effect)
        throw new StorageError('identity-conflict');
      // Keep the original installed owner and offer; never rediscover or prepare a continuation by name.
      outcome = { ...outcome, nextCommand: { commandId: next.commandId, name: binding.modelName, effect: next.effect,
        input: json({ ...input, command: next }) } };
    }
    if (!outcome.wait) return outcome;
    return { ...outcome, wait: { ...outcome.wait, presentation: { ...outcome.wait.presentation,
      toolDiscovery: json({ commandId, bindingId: binding.bindingId, moduleId: binding.moduleId, moduleVersion: binding.moduleVersion }) } } };
  }
  return { id, version,
    async list(context) {
      const current = await catalog(context);
      return [...controlDefinitions.map(definition => controlOffer(definition.name, current.scope, current.catalogVersion)),
        ...(await visible(context, current)).map(binding => delegatedOffer(binding, current.scope))];
    },
    async prepare(context, offer, intent, commandId) {
      z.uuid().parse(commandId);
      if (offer.definition.name !== intent.name) throw new StorageError('forbidden');
      const supplied = { definition: offer.definition, effect: offer.effect, scope: offer.scope };
      const current = await catalog(context), control = controls.find(item => item.name === intent.name);
      if (control) {
        if (!same(supplied, controlOffer(intent.name, current.scope, current.catalogVersion))) throw new StorageError('identity-conflict');
        const input = json({ moduleId: id, moduleVersion: version, scope: current.scope, catalogVersion: current.catalogVersion,
          kind: control.name === 'discover_tools' ? 'discover' : 'load', arguments: control.schema.parse(intent.arguments) });
        const prepared = { commandId, name: intent.name, effect: 'read' as const, input };
        // No unpaired discover from this native batch can authorize a load.
        if (control.name === 'load_tools') await evaluate(context, prepared);
        return prepared;
      }
      const binding = (await visible(context, current)).find(binding => same(supplied, delegatedOffer(binding, current.scope)));
      if (!binding) throw new StorageError('identity-conflict');
      const command = await installedModule(binding).prepare(context, binding.offer, { ...intent, name: binding.offer.definition.name }, commandId);
      if (command.commandId !== commandId || command.name !== binding.offer.definition.name || command.effect !== binding.offer.effect) throw new StorageError('identity-conflict');
      return { commandId, name: binding.modelName, effect: command.effect, input: json({ moduleId: id, moduleVersion: version,
        scope: current.scope, kind: 'delegate', binding, command }) };
    },
    async dispatch(context, command, permit, assertDispatch) {
      const input = fixed(context, command);
      if (permit.sessionId !== context.snapshot.session.sessionId || permit.runId !== context.snapshot.run.runId || permit.operationId !== command.commandId)
        throw new StorageError('forbidden');
      await assertDispatch();
      let delegated = false;
      try {
        if (input.kind !== 'delegate') return await evaluate(context, command);
        const current = await catalog(context);
        if (!(await visible(context, current)).some(binding => binding.bindingId === input.binding.bindingId)) throw new StorageError('identity-conflict');
        const module = installedModule(input.binding);
        const live = async () => { await assertDispatch(); const fresh = await catalog(context);
          if (!fresh.candidates.some(binding => binding.bindingId === input.binding.bindingId)) throw new StorageError('identity-conflict'); await assertDispatch(); };
        await live(); delegated = true;
        return routed(await module.dispatch(context, input.command, permit, live), input, command.commandId);
      } catch (error) {
        // The original owner may have committed. Let the core reconcile that exact nested command.
        if (delegated) throw error;
        return failure(error);
      }
    },
    async reconcile(context, command) {
      const input = fixed(context, command);
      try {
        if (input.kind !== 'delegate') return await evaluate(context, command);
        const module = installedModule(input.binding), current = await catalog(context);
        if (!current.candidates.some(binding => binding.bindingId === input.binding.bindingId)) throw new StorageError('identity-conflict');
        const outcome = await module.reconcile(context, input.command);
        return outcome ? routed(outcome, input, command.commandId) : null;
      } catch (error) {
        if (input.kind === 'delegate' && input.binding.offer.effect !== 'read'
          && (error instanceof StorageError || error instanceof z.ZodError)) {
          const reason = error instanceof StorageError ? error.code : 'invalid';
          return { state: 'unknown', feedback: { outcome: 'error', text: '原工具结果仍未知，无法核对固定模块：' + reason, images: [] }, result: { reason } };
        }
        return failure(error);
      }
    },
    async stop(context, command) {
      const input = fixed(context, command);
      if (input.kind !== 'delegate') return null;
      return await installedModule(input.binding).stop?.(context, input.command) ?? null;
    },
    async validateResponse(context, wait: AgentWait, answer) {
      const routing = z.object({ commandId: z.uuid(), bindingId: hash, moduleId: z.string(), moduleVersion: z.number().int().positive() }).strict().parse(wait.presentation.toolDiscovery);
      const original = context.snapshot.steps.find(step => step.operation.kind === 'tool.call' && step.operation.operationId === routing.commandId);
      if (!original) throw new StorageError('forbidden');
      const input = fixed(context, preparedSchema.parse(original.operation.input.command));
      if (input.kind !== 'delegate' || !same(routing, { commandId: routing.commandId, bindingId: input.binding.bindingId,
        moduleId: input.binding.moduleId, moduleVersion: input.binding.moduleVersion })) throw new StorageError('forbidden');
      const module = installedModule(input.binding);
      if (!module.validateResponse) throw new StorageError('forbidden');
      const { toolDiscovery: _routing, ...presentation } = wait.presentation;
      await module.validateResponse(context, { ...wait, presentation: { ...presentation, moduleId: module.id } }, answer);
    },
  };
}
