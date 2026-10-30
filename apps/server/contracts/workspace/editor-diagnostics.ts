import type { Snapshot } from '../internal/run.ts';
export { editorDiagnosticsInput, diagnosticSchema, editorDiagnosticsResult } from '@xunjie/contracts/editor-diagnostics';
export type { EditorDiagnostic, EditorDiagnosticsInput, EditorDiagnosticsResult } from '@xunjie/contracts/editor-diagnostics';

export type EditorDiagnosticsPacket = {
  recoveryGeneration: string; scope: { userId: string; courseId: string; attemptId: string };
  fileId: string; language: 'c' | 'hdl'; snapshot: Snapshot;
};
