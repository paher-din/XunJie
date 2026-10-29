import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../app/errors.ts';
import { parseRequest } from '../app/validation.ts';
import { readActivity } from '../design/activities.ts';
import { assignmentAvailability } from '../design/activities.ts';
import { manifestHash, sha256, validateSnapshot } from '../../runner/snapshot.ts';
import { editorDiagnosticsInput, editorDiagnosticsResult } from '@xunjie/contracts/editor-diagnostics';
import type { EditorDiagnosticsResult } from '@xunjie/contracts/editor-diagnostics';
import type { EditorDiagnosticsPacket } from '../../contracts/workspace/editor-diagnostics.ts';
import type { Transaction } from '../db/transaction.ts';
import type { WorkspaceState } from './commands.ts';
import type { ActorContext } from '../../contracts/access/index.ts';
import type { RunnerTransport } from '../records/runner.ts';
import { rangeOffsets } from './files.ts';
import type { ExecutionRouting } from '../app/execution-nodes.ts';

type AuthorizedRead = <T>(request: FastifyRequest, id: string, work: (tx: Transaction, state: WorkspaceState, actor: ActorContext) => T) => T;
export function registerEditorDiagnostics(app: FastifyInstance, read: AuthorizedRead, runner: RunnerTransport | undefined,
  generation: (expected: string) => string, attemptId: (request: FastifyRequest) => string, execution?:ExecutionRouting) {
  let busy = false;
  app.post('/api/attempts/:id/editor-diagnostics', { bodyLimit: 8 * 1024 * 1024 }, async request => {
    const input = parseRequest(editorDiagnosticsInput, request.body), id = attemptId(request);
    const prepare = () => read(request, id, (tx, state, actor): EditorDiagnosticsPacket | 'paused' | 'stale' | 'unsupported' => {
      generation(input.recoveryGeneration);
      if (actor.role !== 'student' || actor.userId !== state.attempt.studentId) throw new ApiError('FORBIDDEN');
      const attempt = state.attempt;
      if (!attempt.collecting || attempt.status !== 'active' ||
        !assignmentAvailability(tx, attempt.courseId, attempt.assignmentId, actor.userId).active) return 'paused';
      const activity = readActivity(tx, attempt.courseId, attempt.activityVersionId);
      if (activity.checkRule.limitedHelp && state.checks.some(check => check.state === 'active')) return 'paused';
      if (attempt.workspaceRevision !== input.workspaceRevision || attempt.captureRevision !== input.captureRevision) return 'stale';
      const active = state.files.filter(file => file.lifecycle === 'active');
      if (active.length !== input.files.length || new Set(input.files.map(file => file.fileId)).size !== input.files.length)
        throw new ApiError('INVALID_REFERENCE');
      const files = active.map(file => {
        const draft = input.files.find(item => item.fileId === file.fileId);
        if (!draft || file.documentVersion !== draft.documentVersion || file.contentHash !== draft.contentHash) throw new ApiError('VERSION_CONFLICT');
        if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(draft.text)) throw new ApiError('INVALID_REQUEST');
        return { fileId: file.fileId, path: file.path, documentVersion: file.documentVersion,
          text: draft.text, contentHash: sha256(draft.text) };
      });
      const source = files.find(file => file.fileId === input.fileId);
      if (!source) throw new ApiError('INVALID_REFERENCE');
      const language = 'kind' in activity.runtimeProfile ? 'hdl' : 'c';
      if (!(language === 'hdl' ? /\.(v|vh|sv|svh)$/i : /\.(c|h)$/i).test(source.path)) return 'unsupported';
      const snapshot = { snapshotId: randomUUID(), hashFormat: 'sha256-manifest-v1' as const, hash: manifestHash(files), files };
      validateSnapshot(snapshot);
      return { recoveryGeneration: input.recoveryGeneration, scope: { userId: actor.userId, courseId: actor.courseId, attemptId: id },
        fileId: input.fileId, language, snapshot };
    });
    const packet = prepare();
    const base = { sourceHash: typeof packet === 'string' ? '0'.repeat(64) : packet.snapshot.hash, diagnostics: [] };
    const respond = (status: EditorDiagnosticsResult['status']) => ({ requestId: request.id, data: { ...base, status } });
    if (typeof packet === 'string') return respond(packet);
    let selectedRunner=runner,nodeGeneration=packet.recoveryGeneration;
    if(execution){
      try{const binding=execution.selected(request);selectedRunner=execution.node(binding).runner;nodeGeneration=binding.nodeGeneration;}
      catch{return respond('unavailable');}
    }
    if (!selectedRunner) return respond('unavailable');
    if (busy) return respond('busy');
    busy = true;
    try {
      // This transient analysis has no Job. Its node generation belongs only to the wire packet;
      // prepare() continues to recheck the authenticated business generation and original draft basis.
      const response = await selectedRunner({ op: 'editor_diagnostics', packet:{...packet,recoveryGeneration:nodeGeneration} });
      const current = prepare();
      if (typeof current === 'string') return respond(current);
      if (current.snapshot.hash !== packet.snapshot.hash) return respond('stale');
      const parsed = editorDiagnosticsResult.safeParse((response as { data?: unknown })?.data);
      if (!parsed.success || parsed.data.sourceHash !== packet.snapshot.hash || Buffer.byteLength(JSON.stringify(parsed.data)) > 65536)
        return respond('unavailable');
      if (parsed.data.status !== 'ready' && parsed.data.diagnostics.length) return respond('unavailable');
      for (const item of parsed.data.diagnostics) {
        const file = packet.snapshot.files.find(file => file.fileId === item.fileId);
        if (item.fileId && (!file || file.path !== item.path || file.contentHash !== item.contentHash)) return respond('unavailable');
        if (item.range) {
          if (!file) return respond('unavailable');
          try { const [start, end] = rangeOffsets(file.text, item.range); if (start >= end) return respond('unavailable'); }
          catch { return respond('unavailable'); }
        }
      }
      return { requestId: request.id, data: parsed.data };
    } catch (error) {
      // Recheck revocation even when the external node failed; never leak its raw response.
      const current = prepare();
      if (typeof current === 'string') return respond(current);
      if (error instanceof ApiError) throw error;
      return respond('unavailable');
    } finally { busy = false; }
  });
}
