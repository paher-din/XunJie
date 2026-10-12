import { sha256 } from '../../runner/snapshot.ts';
import { analysisResultSchema,type AnalysisResult,type LearnerScope } from '../../contracts/review/index.ts';
import type { Transaction } from '../db/transaction.ts';
import { ApiError } from '../app/errors.ts';

/** C's original analysis fact; the caller owns admission and uses the same short transaction. */
export function readAnalysisResultInTransaction(tx: Transaction,scope: LearnerScope,jobId: string) {
  const row = tx.get('SELECT * FROM analysis_results WHERE job_id=?',jobId);if (!row) return undefined;
  if (row.course_id !== scope.courseId || row.student_id !== scope.studentId || (scope.attemptId && row.attempt_id !== scope.attemptId)) throw new ApiError('FORBIDDEN');
  const result = analysisResultSchema.parse(JSON.parse(String(row.result_json))),rawBodyText = String(row.raw_body_text);
  if (result.analysisId !== row.analysis_id || result.jobId !== row.job_id || result.disposition !== row.disposition
    || (result.reason ?? null) !== row.reason || result.resultHash !== row.result_hash || sha256(rawBodyText) !== result.resultHash) throw new ApiError('PERSISTENCE_UNAVAILABLE');
  return {...result,rawBodyText};
}
export function replayAnalysisInTransaction(tx: Transaction,scope: LearnerScope,jobId: string,raw: string): AnalysisResult | undefined {
  const previous = readAnalysisResultInTransaction(tx,scope,jobId);if (!previous) return undefined;
  if (previous.resultHash !== sha256(raw)) throw new ApiError('IDEMPOTENCY_CONFLICT');
  const {rawBodyText: _raw,...result} = previous;return result;
}
export function storeAnalysisInTransaction(tx: Transaction,scope: LearnerScope & {attemptId: string},raw: string,result: AnalysisResult,now: string) {
  const value = analysisResultSchema.parse(result);
  if (sha256(raw) !== value.resultHash) throw new ApiError('INVALID_REFERENCE');
  tx.run('INSERT INTO analysis_results(analysis_id,job_id,course_id,student_id,attempt_id,raw_body_text,result_hash,disposition,reason,result_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    value.analysisId,value.jobId,scope.courseId,scope.studentId,scope.attemptId,raw,value.resultHash,value.disposition,value.reason ?? null,JSON.stringify(value),now);
  return value;
}
