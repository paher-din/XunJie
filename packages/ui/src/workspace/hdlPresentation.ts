/** Public facts displayed by the real HDL views. No requests, command identities or stores.
 * Callers supply authorized confirmed results; missing/X/Z signals never become demo zeroes.
 */
export type HdlSignal = 'clock' | 'switches' | 'buttons' | 'resetN' | 'leds' | 'anodes' | 'segments' | 'dp'
export interface HdlBoardProfile { boardProfileVersion: string; mappingVersion: string; topModule: string
  bindings: Array<{ signal: HdlSignal; offset: number; port: string; portOffset: number; width: number }> }
export interface HdlInputs { switches: string; buttons: string; resetN: string }
export interface HdlFrame extends HdlInputs { simTimePs: string; leds: string; anodes: string; segments: string; dp: string }
export type HdlSignalFrame = HdlFrame
export interface HdlDiagnostic { severity: 'error' | 'warning'; message: string; fileId?: string; path?: string
  line?: number; location: 'line-only' | 'unavailable' }
export type HdlBuildStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown'
export interface HdlBuildResult { buildId: string; snapshotId: string; snapshotHash: string
  board: HdlBoardProfile; runtimeProfileVersion: string; engineVersion: string; imageDigest: string; configurationHash: string
  status: HdlBuildStatus; terminationConfirmed: boolean; artifactHash?: string; diagnostics: HdlDiagnostic[]
  stdout: string; stderr: string; failureKind?: string }
export interface HdlBuildView { result: HdlBuildResult | null; status: HdlBuildStatus }
export interface HdlSessionView { sessionId: string; buildId: string; snapshotId: string; snapshotHash: string
  boardProfileVersion: string; mappingVersion: string; engineVersion: string; runtimeProfileVersion: string
  sessionRevision: number; confirmedSequence: number; simTimePs: string
  status: 'starting' | 'active' | 'stopping' | 'stopped' | 'failed' | 'outcome_unknown'
  terminationConfirmed: boolean; stopRequested: boolean; createdAt: string; deadline: string; lastOperationAt: string
  pendingOperationId?: string; failureKind?: string }
export interface HdlOperationResult { operationId: string; sessionId: string; buildId: string; snapshotId: string; snapshotHash: string
  boardProfileVersion: string; mappingVersion: string; engineVersion: string; sequence: number; sessionRevision: number
  frames: HdlFrame[]; finalFrame: HdlFrame; sampleCount: number; droppedFrames: number
  coverage: 'complete' | 'incomplete'; resultHash: string }
