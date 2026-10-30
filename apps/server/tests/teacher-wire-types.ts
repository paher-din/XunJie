// The browser owns structural DTOs so its build never imports server schemas. Check both directions here to
// catch drift without adding backend code or Node-only validation to the browser compilation graph.
import type * as Wire from '../../web/src/teacher/wire.ts';
import type { BlueprintContent, BlueprintDraft } from '../contracts/design/draft.ts';
import type { BlueprintPreview, ActivityView, DesignResult } from '../contracts/design/results.ts';
import type { TeacherWorkbench } from '../contracts/design/workbench.ts';
import type { ReviewContext, EvidenceRef, LearnerClaim, FeedbackView } from '../contracts/review/index.ts';

// HTTP JSON omits undefined object members. Zod output types spell optional values as T | undefined while the
// browser interfaces use ?: T; normalize that spelling before comparing the actual transferable shapes.
type JsonShape<T> = T extends (infer Item)[] ? JsonShape<Item>[] : T extends object
  ? { [Key in keyof T]: JsonShape<Exclude<T[Key], undefined>> } : T;
type SameShape<A, B> = [JsonShape<A>] extends [JsonShape<B>] ? [JsonShape<B>] extends [JsonShape<A>] ? true : false : false;
type Assert<T extends true> = T;
export type TeacherWireCompatibility = [
  Assert<SameShape<Wire.BlueprintContent, BlueprintContent>>,
  Assert<SameShape<Wire.BlueprintDraft, BlueprintDraft>>,
  Assert<SameShape<Wire.BlueprintPreview, BlueprintPreview>>,
  Assert<SameShape<Wire.ActivityView, ActivityView>>,
  Assert<SameShape<Wire.DesignResult, DesignResult>>,
  Assert<SameShape<Wire.TeacherWorkbench, TeacherWorkbench>>,
  Assert<SameShape<Wire.ReviewContext, ReviewContext>>,
  Assert<SameShape<Wire.EvidenceRef, EvidenceRef>>,
  Assert<SameShape<Wire.LearnerClaim, LearnerClaim>>,
  Assert<SameShape<Wire.FeedbackView, FeedbackView>>,
];
