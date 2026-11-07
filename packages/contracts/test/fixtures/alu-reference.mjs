import { randomUUID } from 'node:crypto';
import { executionActionV3Schema } from '@xunjie/contracts/execution';
import { newAluCaseDraft } from '@xunjie/contracts/alu-learning';

// Icarus VCD syntax/changes captured in the waveform slice; original large ticks retained.
export const aluReferenceTrace = `$timescale 1ps $end
$scope module tb $end
$var wire 4 ! mirror [3:0] $end
$upscope $end
$enddefinitions $end
#0
$dumpvars
bx !
$end
#3
bz10 !
#9007199254740996
b1 !
#9007199254740997
b1000 !
#9007199254740998
`;

/** Legal fixed-owner records, not a compiler/Worker fixture or a claimed HDL run. */
export function aluReferenceFixture(options = {}) {
  const identity = options.identity ?? { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
  const activityId = options.activityId ?? randomUUID();
  const binding = options.binding ?? { key: 'alu', definition: { digest: 'a'.repeat(64), manifest: {
    componentId: randomUUID(), version: 3, stateVersion: 3, hostApiVersion: 1, initialState: {} } } };
  const manifest = binding.definition.manifest, requestId = randomUUID();
  const draft = { ...newAluCaseDraft(randomUUID(), randomUUID()), purpose: 'operation',
    predictedF: '0101', predictedCout: '0', reason: 'Frozen student reason', helpReported: true };
  const inputs = { A: 2, B: 3, M: 0, S: 0, Cin: 0 };
  const enabledBy = { requestId: randomUUID(), inputDigest: 'b'.repeat(64), executionRef: randomUUID() };
  const instanceId = `${activityId}:${binding.key}`;
  const content = { ...manifest.initialState, ...inputs, feedbackPolicy: 'hold', caseRequestId: requestId,
    caseDraft: JSON.stringify(draft), enabledBasis: JSON.stringify({ ...enabledBy, definitionDigest: binding.definition.digest }) };
  const stateFile = { objectId: randomUUID(), contentId: randomUUID(), name: `components/${binding.key}.json`, kind: 'state', encoding: 'json',
    mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify({ formatVersion: 1, instanceId,
      componentId: manifest.componentId, version: manifest.version, definitionDigest: binding.definition.digest,
      stateVersion: manifest.stateVersion, operationId: randomUUID(), content }) };
  const codeFile = { objectId: randomUUID(), contentId: randomUUID(), name: 'alu.sv', kind: 'code', encoding: 'utf8',
    mediaType: 'text/plain', value: 'module alu; endmodule\n' };
  const scaffold = randomUUID();
  const action = executionActionV3Schema.parse({ protocolVersion: 3, kind: 'execution', requestId,
    scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId },
    receiver: { receiverId: 'browser-execution', location: 'local', kind: 'execution' },
    execution: { instance: { instanceId, key: binding.key, componentId: manifest.componentId, componentVersion: manifest.version,
      definitionDigest: binding.definition.digest, hostApiVersion: 1, stateVersion: manifest.stateVersion },
      operation: { operationId: 'observe-enabled', effect: 'execute' }, parameters: inputs,
      basis: { enabledBy, works: [codeFile, stateFile], runtime: { adapterId: 'icarus-alu', adapterVersion: 1,
        bundleIdentity: 'c'.repeat(64), resources: [{ resourceId: scaffold, path: 'tb.sv', role: 'scaffold',
          sha256: 'd'.repeat(64), byteLength: 1, mediaType: 'text/plain' }] },
        compile: { top: 'alu', entryFiles: ['alu.sv'], includeDirs: [] },
        observation: { scaffoldResourceId: scaffold, scaffoldVersion: 1, ports: { result: 'F', carry: 'Cout' }, resultFormat: 'xunjie-observations-v1' },
        course: { releaseId: randomUUID(), behaviorRuleDigest: 'e'.repeat(64), planDigest: 'f'.repeat(64) },
        expected: { stateContentId: stateFile.contentId } },
      limits: { compileTimeoutMs: 1000, simulateTimeoutMs: 100, jobTimeoutMs: 2000, memoryMiB: 64,
        inputBytes: 1048576, textBytes: 2097152, vcdBytes: 8388608, resultBytes: 16777216, concurrentJobs: 1, queuedJobs: 1 },
      plan: { planId: 'alu-browser', planVersion: 1, planDigest: 'f'.repeat(64), location: 'browser', kind: 'job' },
      initiator: { kind: 'student', principalId: identity.principalId } } });
  return { identity, activityId, binding, action, inputs, draft, content, stateFile, codeFile, enabledBy };
}
