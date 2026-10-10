import type {Snapshot} from '../runner/index.ts';
export type Range = {startLine:number;startColumn:number;endLine:number;endColumn:number};
export type ObjectRef = {kind:'code';attemptId:string;snapshotId:string;fileId:string;path:string;
  documentVersion:number;contentHash:string;range?:Range;
  source?:{system:'student-ide';session:string;modelId:string;seq?:number}}
  | {kind:'run';attemptId:string;runId:string;snapshotId:string}
  | {kind:'resource';attemptId:string;resourceVersionId:string;paragraphId:string}
  | {kind:'project';attemptId:string;activityVersionId:string};
export type Attempt = {attemptId:string;courseId:string;studentId:string;assignmentId:string;activityVersionId:string;
  status:'ready'|'active'|'paused'|'submitted'|'reviewed';attemptRevision:number;workspaceRevision:number;
  decisionEpoch:number;captureRevision:number;collecting:boolean;reminders:boolean;
  route?:string;question?:string;returnPosition?:ObjectRef};
export type ProjectFile = {fileId:string;attemptId:string;path:string;documentVersion:number;contentHash:string;
  text:string;lifecycle:'active'|'recycled'};
// Internal edit representation uses the already approved UTF-16 range; HTTP/UI adapters remain A/UI-owned.
export type TextChange = {range:Range;text:string};
export type FileOperation = {kind:'create';clientFileKey:string;path:string;text:string}
  | {kind:'update';fileId:string;baseVersion:number;text?:string;changes?:TextChange[]}
  | {kind:'recycle'|'restore';fileId:string;baseVersion:number};
export type SyncBatch = {expectedWorkspaceRevision:number;clientId:string;clientSeq:number;operations:FileOperation[];
  process?:{captureRevision:number}};
export type ArtifactSnapshot = Snapshot & {attemptId:string;activityVersionId:string;workspaceRevision:number;createdAt:string};
