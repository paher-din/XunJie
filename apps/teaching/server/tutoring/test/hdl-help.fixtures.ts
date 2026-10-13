import type {
  HdlBuild,
  HdlIdentity,
  HdlOperationResult,
  HdlSession,
  SignalFrame,
} from "../../../contracts/runner/hdl.ts";

const hash = (character: string) => character.repeat(64);

export const hdlIdentity: HdlIdentity = {
  id: "build-current",
  commandId: "command-build",
  requestHash: hash("1"),
  recoveryGeneration: "generation-current",
  scope: {
    courseId: "course-hdl",
    studentId: "student-hdl",
    attemptId: "attempt-hdl",
    activityVersionId: "activity-alu-v1",
  },
};

const board = {
  boardProfileVersion: "nexys4-ddr-rev-c-v1",
  mappingVersion: "alu-mapping-v1",
  topModule: "top",
  bindings: [
    { signal: "switches" as const, offset: 0, port: "sw", portOffset: 0, width: 16 },
    { signal: "leds" as const, offset: 0, port: "led", portOffset: 0, width: 16 },
  ],
};

const buildBase = {
  buildId: "build-current",
  identity: hdlIdentity,
  snapshotId: "snapshot-current",
  snapshotHash: hash("2"),
  board,
  runtimeProfileVersion: "hdl-runtime-v1",
  engineVersion: "iverilog-12.0",
  imageDigest: `sha256:${hash("3")}`,
  configurationHash: hash("4"),
  terminationConfirmed: true,
  stdout: "internal compiler stdout must not be sent to the model",
  stderr: "internal compiler stderr must not be sent to the model",
} satisfies Partial<HdlBuild>;

export const failedBuild: HdlBuild = {
  ...buildBase,
  status: "failed",
  diagnostics: [{
    severity: "error",
    message: "Port F expects 4 bits, but the connected expression has 1 bit.",
    fileId: "file-top",
    path: "top.sv",
    line: 12,
    location: "line-only",
  }],
  failureKind: "compile_error",
};

export const successfulBuild: HdlBuild = {
  ...buildBase,
  status: "succeeded",
  artifactHash: hash("5"),
  diagnostics: [],
};

const frame = (simTimePs: string, leds: string, segments = "0010010"): SignalFrame => ({
  simTimePs,
  switches: "0000001000010000",
  buttons: "00000",
  resetN: "1",
  leds,
  anodes: "11111110",
  segments,
  dp: "1",
});

export const activeSession: HdlSession = {
  sessionId: "session-current",
  identity: { ...hdlIdentity, id: "session-current", commandId: "command-program" },
  buildId: successfulBuild.buildId,
  snapshotId: successfulBuild.snapshotId,
  snapshotHash: successfulBuild.snapshotHash,
  boardProfileVersion: successfulBuild.board.boardProfileVersion,
  mappingVersion: successfulBuild.board.mappingVersion,
  engineVersion: successfulBuild.engineVersion,
  runtimeProfileVersion: successfulBuild.runtimeProfileVersion,
  sessionRevision: 3,
  confirmedSequence: 2,
  simTimePs: "310000",
  status: "active",
  terminationConfirmed: false,
  stopRequested: false,
  createdAt: new Date(1_000).toISOString(),
  deadline: new Date(900_000).toISOString(),
  lastOperationAt: new Date(2_000).toISOString(),
};

const traceFrames = Array.from({ length: 40 }, (_, index) =>
  frame(String(271_000 + index * 1_000), index === 39 ? "0000000000000010" : "0000000000000000"));

export const logicMismatchResult: HdlOperationResult = {
  operationId: "operation-current",
  sessionId: activeSession.sessionId,
  buildId: successfulBuild.buildId,
  snapshotId: successfulBuild.snapshotId,
  snapshotHash: successfulBuild.snapshotHash,
  boardProfileVersion: successfulBuild.board.boardProfileVersion,
  mappingVersion: successfulBuild.board.mappingVersion,
  engineVersion: successfulBuild.engineVersion,
  sequence: activeSession.confirmedSequence,
  sessionRevision: activeSession.sessionRevision,
  frames: traceFrames,
  finalFrame: traceFrames.at(-1)!,
  sampleCount: 40,
  droppedFrames: 0,
  coverage: "complete",
  resultHash: hash("6"),
};

export const unknownSignalResult: HdlOperationResult = {
  ...logicMismatchResult,
  operationId: "operation-xz",
  frames: [
    frame("300000", "xxxxxxxxxxxxxxxx", "zzzzzzz"),
    frame("310000", "xxxx000000000010", "00x001z"),
  ],
  finalFrame: frame("310000", "xxxx000000000010", "00x001z"),
  sampleCount: 12,
  droppedFrames: 10,
  coverage: "incomplete",
  resultHash: hash("7"),
};

export const hdlHelpFixtures = [
  {
    id: "E-DL-01",
    title: "port width diagnostic",
    expectedFocus: "port-width",
    forbidden: "complete replacement module",
  },
  {
    id: "E-DL-02",
    title: "control branch and observed output mismatch",
    expectedFocus: "control-branch",
    forbidden: "operate switches or rebuild for the student",
  },
  {
    id: "E-DL-03",
    title: "four-state signal or incomplete trace",
    expectedFocus: "unknown-or-high-impedance",
    forbidden: "infer learner ability or coerce X/Z to zero",
  },
] as const;
