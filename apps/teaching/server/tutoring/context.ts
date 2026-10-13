import { createHash } from "node:crypto";
import type {
  AuthorizedStudentHelpContext,
  AuthorizedHdlHelpContext,
  HdlHelpCurrentState,
  LearnerContextClaim,
  StudentHelpRequest,
  UntrustedReference,
} from "../../contracts/tutoring/index.ts";
import type { JobStatus } from "../../contracts/records/index.ts";
import type { HdlDiagnostic, SignalFrame } from "../../contracts/runner/hdl.ts";
import { studentActionTypes } from "../../contracts/tutoring/index.ts";
import { RunnerError } from "../../runner/snapshot.ts";
import type { CurrentGuard, GuardState } from "./core.ts";
import { rangeOffsets } from "../workspace/files.ts";

export type StudentHelpCurrentState = AuthorizedStudentHelpContext["current"] & {
  helpAllowed: boolean;
  learnerStateRevision: number;
  objectAvailable: boolean;
  jobStatus: JobStatus;
  stopRequested: boolean;
  hdl?: HdlHelpCurrentState;
};

export function projectHdlHelpCurrentState(hdl: AuthorizedHdlHelpContext): HdlHelpCurrentState {
  return {
    snapshotId: hdl.snapshotId,
    snapshotHash: hdl.snapshotHash,
    buildId: hdl.build.buildId,
    buildStatus: hdl.build.status,
    ...(hdl.session ? {
      sessionId: hdl.session.sessionId,
      sessionRevision: hdl.session.sessionRevision,
      sessionStatus: hdl.session.status,
      sessionGeneration: hdl.session.identity.recoveryGeneration,
      confirmedSequence: hdl.session.confirmedSequence,
      simTimePs: hdl.session.simTimePs,
    } : {}),
    ...(hdl.operation ? {
      operationId: hdl.operation.operationId,
      resultHash: hdl.operation.resultHash,
    } : {}),
  };
}

export function assembleStudentHelpRequest(
  input: AuthorizedStudentHelpContext,
  signal?: AbortSignal,
): StudentHelpRequest {
  assertAuthorizedContext(input);
  const studentId = input.job.scope.studentId;
  const attemptId = input.job.scope.attemptId;
  if (!studentId || !attemptId) throw new RunnerError("FORBIDDEN", "Student help scope required");
  const references: UntrustedReference[] = [];
  const add = (reference: UntrustedReference) => {
    if (references.some((item) => item.id === reference.id)) return;
    references.push(reference);
  };

  const projectId = `project:${input.activity.activityVersionId}`;
  add({
    id: projectId,
    content: JSON.stringify({
      source: "approved_activity",
      activityVersionId: input.activity.activityVersionId,
      goals: input.activity.content.content.goals,
      tasks: input.activity.content.content.tasks,
      milestones: input.activity.content.content.milestones,
      helpPolicyVersionId: input.activity.helpPolicy.versionId,
    }),
  });

  if (input.objectRef) addObjectReference(input, add);
  if (input.hdl) addHdlReferences(input, add);
  const selectedResources = selectResourceParagraphs(input);
  if (selectedResources.length === 0) {
    add({
      id: "course-resources:unavailable",
      content: JSON.stringify({
        source: "approved_course_resource",
        status: "unavailable",
        reason: "No approved relevant course paragraph is available for this question.",
      }),
    });
  } else {
    for (const reference of selectedResources) add(reference);
  }

  const relevantClaims = input.learnerClaims.filter((claim) => relevantClaim(input, claim));
  if (relevantClaims.length === 0) {
    add({
      id: `learner-state:${input.learnerStateRevision}:unknown`,
      content: JSON.stringify({
        source: "learner_state",
        learnerStateRevision: input.learnerStateRevision,
        state: "unknown",
        reason: "No applicable active or contested claim is available.",
      }),
    });
  } else {
    for (const claim of relevantClaims) {
      add({
        id: `claim:${claim.claimId}:${claim.claimRevision}`,
        content: JSON.stringify({
          source: "learner_state",
          learnerStateRevision: input.learnerStateRevision,
          competencyId: claim.competencyId,
          competencyVersion: claim.competencyVersion,
          statement: claim.statement,
          state: claim.state,
          validity: claim.validity,
          evidenceIds: claim.evidenceIds,
          counterEvidenceIds: claim.counterEvidenceIds,
          assistanceStatus: claim.assistanceStatus,
          unresolved: claim.unresolved,
        }),
      });
    }
  }

  for (const action of input.assistanceHistory
    .filter((item) => item.status === "displayed" || item.status === "acknowledged")
    .slice(-3)) {
    add({
      id: `assistance:${action.actionId}`,
      content: JSON.stringify({
        source: "actual_help",
        actionType: action.actionType,
        content: action.content,
        status: action.status,
      }),
    });
  }

  return {
    context: {
      jobId: input.job.jobId,
      purpose: "student_help",
      scope: {
        courseId: input.job.scope.courseId,
        userId: studentId,
        attemptId,
      },
      authorizedReferenceIds: references.map((reference) => reference.id),
      acceptedAtMs: Date.parse(input.job.acceptedAt),
      deadlineAtMs: Date.parse(input.job.deadline),
      budgetAvailable: input.budgetAvailable,
      versions: input.versions,
    },
    question: input.question,
    ...(input.hdl ? { domain: "hdl" as const } : {}),
    ...(input.objectRef ? { objectRef: structuredClone(input.objectRef) } : {}),
    references,
    policy: {
      helpAllowed: input.activity.helpPolicy.helpAllowed && !input.current.limitedCheck,
      wholeSolutionAllowed: false,
    },
    ...(signal ? { signal } : {}),
  };
}

export function createStudentHelpCurrentGuard(
  expected: AuthorizedStudentHelpContext,
  readCurrent: (signal: AbortSignal) => StudentHelpCurrentState | Promise<StudentHelpCurrentState>,
): CurrentGuard {
  return async (signal): Promise<GuardState> => {
    if (signal.aborted) return "cancelled";
    const current = await readCurrent(signal);
    if (signal.aborted || current.stopRequested || ["cancelling", "cancelled"].includes(current.jobStatus)) {
      return "cancelled";
    }
    if (
      current.jobStatus !== "queued" && current.jobStatus !== "running" ||
      current.recoveryGeneration !== expected.job.recoveryGeneration ||
      current.decisionEpoch !== expected.job.decisionEpoch ||
      current.activityVersionId !== expected.activity.activityVersionId ||
      current.helpPolicyVersionId !== expected.activity.helpPolicy.versionId ||
      current.learnerStateRevision !== expected.learnerStateRevision ||
      !current.objectAvailable ||
      current.attemptStatus !== "active" ||
      !current.assignmentActive ||
      current.limitedCheck ||
      !current.helpAllowed
      || !sameHdlCurrent(expected, current.hdl)
    ) {
      return "stale";
    }
    return "current";
  };
}

function assertAuthorizedContext(input: AuthorizedStudentHelpContext) {
  const { job, current } = input;
  if (
    job.purpose !== "student_help" ||
    !job.scope.studentId ||
    !job.scope.attemptId ||
    job.decisionEpoch !== current.decisionEpoch ||
    job.recoveryGeneration !== current.recoveryGeneration ||
    current.activityVersionId !== input.activity.activityVersionId ||
    current.helpPolicyVersionId !== input.activity.helpPolicy.versionId ||
    input.activity.courseId !== job.scope.courseId ||
    current.attemptStatus !== "active" ||
    !current.assignmentActive ||
    current.limitedCheck ||
    job.stopRequested ||
    (job.status !== "queued" && job.status !== "running") ||
    input.activity.status !== "active" ||
    !input.activity.helpPolicy.helpAllowed ||
    !input.question.trim() ||
    !Number.isSafeInteger(input.learnerStateRevision) ||
    input.learnerStateRevision < 0 ||
    input.learnerClaims.some((claim) => !validLearnerClaim(claim)) ||
    input.assistanceHistory.some((item) =>
      !item.actionId ||
      !studentActionTypes.includes(item.actionType) ||
      typeof item.content !== "string" ||
      !["generated", "received", "displayed", "acknowledged", "cancelled", "stale", "failed"].includes(item.status)) ||
    !validHdlContext(input) ||
    !Number.isFinite(Date.parse(job.acceptedAt)) ||
    !Number.isFinite(Date.parse(job.deadline)) ||
    Date.parse(job.deadline) <= Date.parse(job.acceptedAt)
  ) {
    throw new RunnerError("STATE_CONFLICT", "Student help context is not current");
  }
}

function validHdlContext(input: AuthorizedStudentHelpContext): boolean {
  const hdl = input.hdl;
  if (!hdl) return true;
  const attemptId = input.job.scope.attemptId;
  const studentId = input.job.scope.studentId;
  if (!attemptId || !studentId) return false;
  const snapshot = input.snapshots.find((item) =>
    item.snapshotId === hdl.snapshotId &&
    item.hash === hdl.snapshotHash &&
    item.attemptId === attemptId &&
    item.activityVersionId === input.current.activityVersionId);
  const build = hdl.build;
  if (
    !snapshot ||
    build.buildId !== build.identity.id ||
    build.snapshotId !== hdl.snapshotId ||
    build.snapshotHash !== hdl.snapshotHash ||
    !validHash(hdl.snapshotHash) ||
    !validHash(build.configurationHash) ||
    build.identity.recoveryGeneration !== input.current.recoveryGeneration ||
    !sameHdlScope(input, build.identity.scope) ||
    !["succeeded", "failed"].includes(build.status) ||
    !build.terminationConfirmed ||
    build.diagnostics.length > 100 ||
    !build.diagnostics.every((diagnostic) => {
      if (diagnostic.location === "unavailable") return true;
      return Number.isSafeInteger(diagnostic.line) &&
        (diagnostic.line ?? 0) > 0 &&
        snapshot.files.some((file) => file.fileId === diagnostic.fileId && file.path === diagnostic.path);
    })
  ) return false;
  if (input.objectRef?.kind === "code" && input.objectRef.snapshotId !== hdl.snapshotId) return false;
  if (input.objectRef?.kind === "run") return false;

  const session = hdl.session;
  const operation = hdl.operation;
  if (!session) return operation === undefined;
  if (
    build.status !== "succeeded" ||
    session.buildId !== build.buildId ||
    session.snapshotId !== hdl.snapshotId ||
    session.snapshotHash !== hdl.snapshotHash ||
    session.boardProfileVersion !== build.board.boardProfileVersion ||
    session.mappingVersion !== build.board.mappingVersion ||
    session.engineVersion !== build.engineVersion ||
    session.runtimeProfileVersion !== build.runtimeProfileVersion ||
    session.identity.recoveryGeneration !== input.current.recoveryGeneration ||
    !sameHdlScope(input, session.identity.scope) ||
    session.status !== "active" ||
    session.stopRequested ||
    session.terminationConfirmed ||
    !Number.isSafeInteger(session.sessionRevision) ||
    session.sessionRevision < 1 ||
    !Number.isSafeInteger(session.confirmedSequence) ||
    session.confirmedSequence < 0 ||
    !validSimTime(session.simTimePs)
  ) return false;
  if (!operation) return true;
  const lastFrame = operation.frames.at(-1);
  return operation.sessionId === session.sessionId &&
    operation.buildId === build.buildId &&
    operation.snapshotId === hdl.snapshotId &&
    operation.snapshotHash === hdl.snapshotHash &&
    operation.boardProfileVersion === session.boardProfileVersion &&
    operation.mappingVersion === session.mappingVersion &&
    operation.engineVersion === session.engineVersion &&
    operation.sessionRevision === session.sessionRevision &&
    operation.sequence === session.confirmedSequence &&
    validHash(operation.resultHash) &&
    Number.isSafeInteger(operation.sessionRevision) &&
    operation.sessionRevision > 0 &&
    Number.isSafeInteger(operation.sequence) &&
    operation.sequence >= 0 &&
    Number.isSafeInteger(operation.sampleCount) &&
    operation.sampleCount >= 0 &&
    Number.isSafeInteger(operation.droppedFrames) &&
    operation.droppedFrames >= 0 &&
    operation.sampleCount >= operation.frames.length &&
    (operation.coverage !== "complete" || operation.droppedFrames === 0) &&
    operation.frames.length > 0 &&
    operation.frames.length <= 4096 &&
    Boolean(lastFrame) &&
    operation.frames.every(validHdlFrame) &&
    lastFrame!.simTimePs === session.simTimePs &&
    sameHdlFrame(lastFrame!, operation.finalFrame) &&
    operation.frames.every((frame, index) =>
      index === 0 || BigInt(frame.simTimePs) >= BigInt(operation.frames[index - 1]!.simTimePs));
}

function validSimTime(value: string): boolean {
  return /^\d{1,32}$/.test(value);
}

function validHash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function validHdlFrame(frame: SignalFrame): boolean {
  return validSimTime(frame.simTimePs) &&
    /^[01xz]{16}$/.test(frame.switches) &&
    /^[01xz]{5}$/.test(frame.buttons) &&
    /^[01xz]$/.test(frame.resetN) &&
    /^[01xz]{16}$/.test(frame.leds) &&
    /^[01xz]{8}$/.test(frame.anodes) &&
    /^[01xz]{7}$/.test(frame.segments) &&
    /^[01xz]$/.test(frame.dp);
}

function sameHdlFrame(left: SignalFrame, right: SignalFrame): boolean {
  return left.simTimePs === right.simTimePs &&
    left.switches === right.switches &&
    left.buttons === right.buttons &&
    left.resetN === right.resetN &&
    left.leds === right.leds &&
    left.anodes === right.anodes &&
    left.segments === right.segments &&
    left.dp === right.dp;
}

function sameHdlScope(
  input: AuthorizedStudentHelpContext,
  scope: { courseId: string; studentId: string; attemptId: string; activityVersionId: string },
): boolean {
  return scope.courseId === input.job.scope.courseId &&
    scope.studentId === input.job.scope.studentId &&
    scope.attemptId === input.job.scope.attemptId &&
    scope.activityVersionId === input.current.activityVersionId;
}

function sameHdlCurrent(
  expected: AuthorizedStudentHelpContext,
  current: HdlHelpCurrentState | undefined,
): boolean {
  const hdl = expected.hdl;
  if (!hdl) return true;
  if (!current) return false;
  const session = hdl.session;
  const operation = hdl.operation;
  return current.snapshotId === hdl.snapshotId &&
    current.snapshotHash === hdl.snapshotHash &&
    current.buildId === hdl.build.buildId &&
    current.buildStatus === hdl.build.status &&
    current.sessionId === session?.sessionId &&
    current.sessionRevision === session?.sessionRevision &&
    current.sessionStatus === session?.status &&
    current.sessionGeneration === session?.identity.recoveryGeneration &&
    current.confirmedSequence === session?.confirmedSequence &&
    current.simTimePs === session?.simTimePs &&
    current.operationId === operation?.operationId &&
    current.resultHash === operation?.resultHash;
}

function addHdlReferences(
  input: AuthorizedStudentHelpContext,
  add: (reference: UntrustedReference) => void,
) {
  const hdl = input.hdl!;
  const build = hdl.build;
  const snapshot = input.snapshots.find((item) =>
    item.snapshotId === hdl.snapshotId &&
    item.hash === hdl.snapshotHash &&
    item.attemptId === input.job.scope.attemptId &&
    item.activityVersionId === input.current.activityVersionId)!;
  add({
    id: boundedReferenceId("hdl-build", [build.buildId, build.snapshotHash, build.configurationHash]),
    content: JSON.stringify({
      source: "authorized_hdl_build",
      snapshotId: build.snapshotId,
      snapshotHash: build.snapshotHash,
      buildId: build.buildId,
      status: build.status,
      boardProfileVersion: build.board.boardProfileVersion,
      mappingVersion: build.board.mappingVersion,
      runtimeProfileVersion: build.runtimeProfileVersion,
      engineVersion: build.engineVersion,
      failureKind: build.failureKind ?? null,
      diagnostics: build.diagnostics.slice(0, 8).map((diagnostic) =>
        visibleHdlDiagnostic(diagnostic, snapshot)),
      omittedDiagnosticCount: Math.max(0, build.diagnostics.length - 8),
    }),
  });
  const session = hdl.session;
  const operation = hdl.operation;
  if (!session || !operation) return;
  add({
    id: boundedReferenceId("hdl-signal", [operation.operationId, operation.resultHash, session.simTimePs]),
    content: JSON.stringify({
      source: "authorized_hdl_signal_frame",
      sessionId: session.sessionId,
      buildId: session.buildId,
      sessionRevision: session.sessionRevision,
      sequence: operation.sequence,
      simulationTimePs: session.simTimePs,
      frame: visibleHdlFrame(operation.finalFrame),
    }),
  });
  const frames = operation.frames.slice(-32);
  add({
    id: boundedReferenceId("hdl-trace", [operation.operationId, operation.resultHash, frames[0]!.simTimePs, frames.at(-1)!.simTimePs]),
    content: JSON.stringify({
      source: "authorized_hdl_trace_summary",
      sessionId: session.sessionId,
      buildId: session.buildId,
      sessionRevision: session.sessionRevision,
      sequence: operation.sequence,
      fromSimulationTimePs: frames[0]!.simTimePs,
      toSimulationTimePs: frames.at(-1)!.simTimePs,
      frames: frames.map(visibleHdlFrame),
      returnedFrameCount: frames.length,
      originalFrameCount: operation.frames.length,
      sampleCount: operation.sampleCount,
      droppedFrames: operation.droppedFrames,
      coverage: operation.coverage,
      locallyTruncated: operation.frames.length > frames.length,
    }),
  });
}

function visibleHdlDiagnostic(
  diagnostic: HdlDiagnostic,
  snapshot: AuthorizedStudentHelpContext["snapshots"][number],
) {
  const file = diagnostic.location === "line-only"
    ? snapshot.files.find((item) => item.fileId === diagnostic.fileId && item.path === diagnostic.path)
    : undefined;
  const lineAvailable = file !== undefined &&
    Number.isSafeInteger(diagnostic.line) &&
    (diagnostic.line ?? 0) > 0 &&
    (diagnostic.line ?? 0) <= physicalLineCount(file.text);
  return {
    severity: diagnostic.severity,
    message: diagnostic.message.slice(0, 1024),
    fileId: lineAvailable ? diagnostic.fileId ?? null : null,
    path: lineAvailable ? diagnostic.path ?? null : null,
    line: lineAvailable ? diagnostic.line ?? null : null,
    location: lineAvailable ? "line-only" : "unavailable",
  };
}

function physicalLineCount(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

function visibleHdlFrame(frame: SignalFrame): SignalFrame {
  return {
    simTimePs: frame.simTimePs,
    switches: frame.switches,
    buttons: frame.buttons,
    resetN: frame.resetN,
    leds: frame.leds,
    anodes: frame.anodes,
    segments: frame.segments,
    dp: frame.dp,
  };
}

function validLearnerClaim(claim: LearnerContextClaim): boolean {
  return Boolean(claim.claimId) &&
    Number.isSafeInteger(claim.claimRevision) && claim.claimRevision > 0 &&
    Boolean(claim.competencyId) &&
    Number.isSafeInteger(claim.competencyVersion) && claim.competencyVersion > 0 &&
    typeof claim.statement === "string" &&
    ["insufficient", "supported_with_assistance", "supported_in_check", "conflicting"].includes(claim.state) &&
    ["active", "contested", "superseded", "withdrawn"].includes(claim.validity) &&
    claim.evidenceIds.every((value) => typeof value === "string") &&
    claim.counterEvidenceIds.every((value) => typeof value === "string") &&
    ["observed_help", "none_observed_in_system", "unknown"].includes(claim.assistanceStatus) &&
    typeof claim.unresolved === "boolean";
}

function addObjectReference(
  input: AuthorizedStudentHelpContext,
  add: (reference: UntrustedReference) => void,
) {
  const reference = input.objectRef!;
  if (reference.attemptId !== input.job.scope.attemptId) {
    throw new RunnerError("INVALID_REFERENCE", "Object reference attempt mismatch");
  }
  if (reference.kind === "project") {
    if (reference.activityVersionId !== input.activity.activityVersionId) {
      throw new RunnerError("INVALID_REFERENCE", "Project reference version mismatch");
    }
    return;
  }
  if (reference.kind === "resource") {
    const paragraph = availableParagraphs(input).find((item) =>
      item.resourceVersionId === reference.resourceVersionId && item.paragraphId === reference.paragraphId);
    if (!paragraph) throw new RunnerError("INVALID_REFERENCE", "Authorized resource paragraph unavailable");
    add({ id: paragraph.id, content: paragraph.content });
    return;
  }
  if (reference.kind === "run") {
    const diagnostic = input.diagnostics.find((item) =>
      item.runId === reference.runId && item.snapshotId === reference.snapshotId);
    if (!diagnostic) throw new RunnerError("INVALID_REFERENCE", "Authorized run diagnostics unavailable");
    add({
      id: `run:${reference.runId}:${reference.snapshotId}`,
      content: JSON.stringify({ source: "runner_diagnostics", ...diagnostic }),
    });
    return;
  }

  const snapshot = input.snapshots.find((item) => item.snapshotId === reference.snapshotId &&
    item.attemptId === reference.attemptId && item.activityVersionId === input.activity.activityVersionId);
  const file = snapshot?.files.find((item) => item.fileId === reference.fileId &&
    item.path === reference.path && item.documentVersion === reference.documentVersion &&
    item.contentHash === reference.contentHash);
  if (!snapshot || !file) throw new RunnerError("INVALID_REFERENCE", "Authorized code snapshot unavailable");
  let text = file.text;
  if (reference.range) {
    const [start, end] = rangeOffsets(text, reference.range);
    text = text.slice(start, end);
  }
  add({
    id: boundedReferenceId("code", [
      reference.snapshotId,
      reference.fileId,
      reference.documentVersion,
      reference.contentHash,
    ]),
    content: JSON.stringify({
      source: "confirmed_snapshot",
      snapshotId: reference.snapshotId,
      fileId: reference.fileId,
      path: reference.path,
      documentVersion: reference.documentVersion,
      contentHash: reference.contentHash,
      range: reference.range ?? null,
      text,
    }),
  });
}

function selectResourceParagraphs(input: AuthorizedStudentHelpContext): UntrustedReference[] {
  const exact = input.objectRef?.kind === "resource"
    ? `${input.objectRef.resourceVersionId}:${input.objectRef.paragraphId}`
    : undefined;
  const terms = searchTerms(input.question);
  return availableParagraphs(input)
    .map((paragraph) => ({
      paragraph,
      score: paragraph.key === exact ? Number.MAX_SAFE_INTEGER : terms.reduce(
        (sum, term) => sum + (paragraph.searchable.includes(term) ? 1 : 0),
        0,
      ),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.paragraph.id.localeCompare(right.paragraph.id))
    .slice(0, 3)
    .map(({ paragraph }) => ({ id: paragraph.id, content: paragraph.content }));
}

function availableParagraphs(input: AuthorizedStudentHelpContext) {
  return input.activity.content.materials.flatMap((material) => {
    if (material.status !== "available") return [];
    return material.paragraphs.flatMap((paragraph) => {
      if (!paragraph.paragraphId) return [];
      const id = boundedReferenceId("resource", [
        material.resourceVersionId,
        paragraph.paragraphId,
        paragraph.contentHash,
      ]);
      const content = JSON.stringify({
        source: "approved_course_resource",
        resourceVersionId: material.resourceVersionId,
        paragraphId: paragraph.paragraphId,
        contentHash: paragraph.contentHash,
        title: material.title,
        text: paragraph.text,
      });
      return [{
        id,
        key: `${material.resourceVersionId}:${paragraph.paragraphId}`,
        resourceVersionId: material.resourceVersionId,
        paragraphId: paragraph.paragraphId,
        content,
        searchable: `${material.title}\n${paragraph.text}`.toLocaleLowerCase(),
      }];
    });
  });
}

function boundedReferenceId(
  kind: "code" | "resource" | "hdl-build" | "hdl-signal" | "hdl-trace",
  identity: readonly (string | number)[],
): string {
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return `${kind}:${digest}`;
}

function searchTerms(value: string): string[] {
  const normalized = value.toLocaleLowerCase();
  const words = normalized.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const cjk = normalized.match(/[\p{Script=Han}]+/gu) ?? [];
  const grams = cjk.flatMap((part) => {
    const characters = [...part];
    return characters.length < 2
      ? characters
      : characters.slice(0, -1).map((character, index) => character + characters[index + 1]);
  });
  return [...new Set([...words.filter((word) => word.length > 1), ...grams])];
}

function relevantClaim(input: AuthorizedStudentHelpContext, claim: LearnerContextClaim): boolean {
  if (claim.validity !== "active" && claim.validity !== "contested") return false;
  if (claim.activityVersionId && claim.activityVersionId !== input.activity.activityVersionId) return false;
  return input.activity.content.content.goals.some((goal) =>
    goal.competencyId === claim.competencyId && goal.competencyVersion === claim.competencyVersion);
}
