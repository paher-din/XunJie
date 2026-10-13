import assert from "node:assert/strict";
import test from "node:test";
import { createDeepSeekProvider, InputLimitError, SyntheticProvider } from "../providers.ts";
import type { ModelProvider } from "../providers.ts";
import {
  executeClaimedLearnerAnalysis,
  type ClaimedLearnerAnalysis,
  type LearnerAnalysisCurrentState,
} from "../analysis.ts";
import { recordModelCall } from "../../records/jobs.ts";
import { readAttempt, readRecords, saveJob } from "../../db/records-adapter.ts";
import { readActivity } from "../../design/activities.ts";
import { readContext } from "../../review/storage.ts";
import { setup, command, helpBody } from "../../../tests/review-support.ts";
import { learnerAnalysisFixtures } from "./learner-analysis.fixtures.ts";

test("B3 fixed synthetic fixture matrix keeps all eight evidence and feedback boundaries explicit", () => {
  assert.deepEqual(learnerAnalysisFixtures.map((fixture) => fixture.id), [
    "E-B3-01", "E-B3-02", "E-B3-03", "E-B3-04",
    "E-B3-05", "E-B3-06", "E-B3-07", "E-B3-08",
  ]);
  assert.equal(new Set(learnerAnalysisFixtures.map((fixture) => fixture.id)).size, 8);
  assert.equal(learnerAnalysisFixtures.find((fixture) => fixture.id === "E-B3-04")?.expected.state, "insufficient");
  assert.match(learnerAnalysisFixtures.find((fixture) => fixture.id === "E-B3-06")!.forbidden, /revive/);
  assert.match(learnerAnalysisFixtures.find((fixture) => fixture.id === "E-B3-08")!.forbidden, /formal Feedback/);
});

test("B3 produces a strict evidence-grounded body and A4 accepts it through the real analysis transaction", async () => {
  const s = await setup();
  try {
    const queued = await s.queue();
    const claimed = s.f.review.claimAnalysis(queued.jobId) as ClaimedLearnerAnalysis;
    const targets = s.content.goals.map((goal: { competencyId: string; competencyVersion: number; domain: "domain" | "project" | "ai_collaboration" }) => ({
      competencyId: goal.competencyId,
      competencyVersion: goal.competencyVersion,
      domain: goal.domain,
      scope: { kind: "activity" as const, activityVersionId: s.activityId },
    }));
    const validBody = {
      kind: "learner_analysis",
      claims: [{
        competencyId: "k",
        competencyVersion: 1,
        domain: "domain",
        scope: { kind: "activity", activityVersionId: s.activityId },
        statement: "The current snapshot does not yet include an observed explanation.",
        state: "insufficient",
        evidenceIds: [s.snapshotId],
        counterEvidenceIds: [],
        assistanceStatus: "unknown",
        unresolved: true,
        unknown: ["No independent explanation or trusted check is available."],
      }],
      feedbackDraft: "Draft: ask the student to explain the choice before making a formal judgment.",
    };
    const provider = new SyntheticProvider([
      { body: { ...validBody, forgedScope: "foreign-course" } },
      { body: validBody, usage: { status: "actual", inputTokens: 31, outputTokens: 17 } },
    ]);
    const outcome = await executeClaimedLearnerAnalysis({
      claimed,
      targets,
      references: [{ id: s.snapshotId, content: "Synthetic confirmed snapshot" }],
    }, analysisRuntime(s, claimed, provider));
    assert.equal(outcome.outcome, "success");
    assert.equal(outcome.calls, 2, "one strict-schema repair shares the original call budget");
    assert.deepEqual(outcome.usage, { status: "unknown" }, "a repair with missing first-call usage remains unknown");
    assert.deepEqual(
      (provider.calls[0]?.untrustedInput as { referenceRoles: unknown }).referenceRoles,
      { input: [s.snapshotId], assistance: [], coverage: [] },
      "the model sees trusted reference roles instead of inferring assistance or coverage from prose",
    );
    if (outcome.outcome !== "success") return;
    assert.deepEqual(outcome.body, validBody);
    assert.ok(!("forgedScope" in outcome.body));

    const accepted = s.f.review.completeAnalysis({
      jobId: queued.jobId,
      leaseToken: claimed.leaseToken,
      recoveryGeneration: s.f.generation(),
      bodyJson: JSON.stringify(outcome.body),
    });
    assert.equal(accepted.disposition, "accepted");
    const current = s.f.db.withTransaction((tx) => s.f.review.readCurrentInTransaction(tx, {
      courseId: "course",
      studentId: "student",
      attemptId: s.attemptId,
    }));
    assert.equal(current.learnerStateRevision, 1);
    assert.equal(current.claims.length, 1);
    const stored = current.claims[0];
    assert.ok(stored);
    assert.equal(stored.source, "model_candidate");
    assert.equal(stored.assistanceStatus, "unknown");
    assert.equal(stored.unresolved, true);
  } finally {
    await s.f.close();
  }
});

test("B3 rejects unsupported targets, fabricated references, and policy-invalid evidence semantics", async (t) => {
  const cases = [
    {
      name: "unknown target",
      change: { competencyId: "not-authorized" },
    },
    {
      name: "fabricated reference",
      change: { evidenceIds: ["foreign-reference"] },
    },
    {
      name: "assisted state without observed help",
      change: { state: "supported_with_assistance", assistanceStatus: "unknown" },
    },
    {
      name: "conflict without counter-evidence",
      change: { state: "conflicting", counterEvidenceIds: [] },
    },
    {
      name: "unknown discarded by resolved flag",
      change: { unresolved: false, unknown: ["Collection gap remains"] },
    },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const s = await setup();
    try {
      const queued = await s.queue();
      const claimed = s.f.review.claimAnalysis(queued.jobId) as ClaimedLearnerAnalysis;
      const claim = {
        competencyId: "k",
        competencyVersion: 1,
        domain: "domain",
        scope: { kind: "activity", activityVersionId: s.activityId },
        statement: "Synthetic candidate",
        state: "insufficient",
        evidenceIds: [s.snapshotId],
        counterEvidenceIds: [],
        assistanceStatus: "unknown",
        unresolved: true,
        unknown: ["No independent check"],
        ...item.change,
      };
      const provider = new SyntheticProvider([
        { body: { kind: "learner_analysis", claims: [claim] } },
        { body: { kind: "learner_analysis", claims: [claim] } },
      ]);
      const outcome = await executeClaimedLearnerAnalysis({
        claimed,
        targets: [{ competencyId: "k", competencyVersion: 1, domain: "domain", scope: { kind: "activity", activityVersionId: s.activityId } }],
        references: [{ id: s.snapshotId, content: "Synthetic snapshot" }],
      }, analysisRuntime(s, claimed, provider));
      assert.equal(outcome.outcome, "rejected");
      assert.equal(outcome.code, "INVALID_MODEL_OUTPUT");
      assert.equal(outcome.calls, 2);
      assert.equal((await s.state()).learnerStateRevision, 0);
    } finally {
      await s.f.close();
    }
  });
});

test("B3 review of the A4 optional B2 state seam uses real transactions and ignores injected revisions", async () => {
  const s = await setup();
  try {
    const queued = await s.queue();
    const claimed = s.f.review.claimAnalysis(queued.jobId) as ClaimedLearnerAnalysis;
    const provider = new SyntheticProvider([{ body: {
      kind: "learner_analysis",
      claims: [{
        competencyId: "k",
        competencyVersion: 1,
        domain: "domain",
        scope: { kind: "activity", activityVersionId: s.activityId },
        statement: "An explanation is still needed.",
        state: "insufficient",
        evidenceIds: [s.snapshotId],
        counterEvidenceIds: [],
        assistanceStatus: "unknown",
        unresolved: true,
        unknown: ["No explanation observed"],
      }],
    } }]);
    const generated = await executeClaimedLearnerAnalysis({
      claimed,
      targets: [{ competencyId: "k", competencyVersion: 1, domain: "domain", scope: { kind: "activity", activityVersionId: s.activityId } }],
      references: [{ id: s.snapshotId, content: "Synthetic snapshot" }],
    }, analysisRuntime(s, claimed, provider));
    assert.equal(generated.outcome, "success");
    if (generated.outcome !== "success") return;
    s.f.review.completeAnalysis({
      jobId: queued.jobId,
      leaseToken: claimed.leaseToken,
      recoveryGeneration: s.f.generation(),
      bodyJson: JSON.stringify(generated.body),
    });
    const state = await s.state();
    const claim = state.claims[0];

    const help = await command(s.f, s.student, `/api/attempts/${s.attemptId}/help`, {
      question: "Explain the approach",
      expectedAttemptRevision: (await s.attempt()).attempt.attemptRevision,
    });
    assert.equal(help.statusCode, 200, help.body);
    const jobId = help.json().data.result.jobId;
    const prepared = await s.f.app.inject({
      method: "POST",
      url: `/fixture/prepare/${s.attemptId}/${jobId}`,
      headers: s.student,
      payload: { learnerStateRevision: 900, learnerClaims: [] },
    });
    assert.equal(prepared.statusCode, 200, prepared.body);
    const references = prepared.json().data.references as { id: string; content: string }[];
    const claimReference = references.find((reference) => reference.id === `claim:${claim.claimId}:1`);
    assert.ok(claimReference);
    assert.equal(JSON.parse(claimReference.content).learnerStateRevision, 1);
    assert.ok(!JSON.stringify(references).includes("900"));

    let calls = 0;
    const later = await s.queue();
    const laterLease = s.f.review.claimAnalysis(later.jobId) as ClaimedLearnerAnalysis;
    s.f.setProvider({ async generate() {
      calls += 1;
      s.f.review.completeAnalysis({
        jobId: later.jobId,
        leaseToken: laterLease.leaseToken,
        recoveryGeneration: s.f.generation(),
        bodyJson: JSON.stringify({
          kind: "learner_analysis",
          claims: [{
            competencyId: "p", competencyVersion: 1, domain: "project",
            scope: { kind: "activity", activityVersionId: s.activityId },
            statement: "A project decision is still unexplained.", state: "insufficient",
            evidenceIds: [s.snapshotId], counterEvidenceIds: [], assistanceStatus: "unknown",
            unresolved: true, unknown: ["No explanation observed"],
          }],
        }),
      });
      return { body: helpBody(), usage: { status: "actual", inputTokens: 13, outputTokens: 8 } };
    } });
    const execution = await command(s.f, s.student, `/fixture/execute/${s.attemptId}/${jobId}`, {});
    assert.equal(execution.statusCode, 200, execution.body);
    assert.equal(execution.json().data.outcome.outcome, "stale");
    assert.equal(execution.json().data.delivery, undefined);
    assert.equal(calls, 1);
  } finally {
    await s.f.close();
  }
});

test("B3 shares the three-call, deadline, cancellation, usage, lease, and currentness boundaries", async (t) => {
  await t.test("dynamic budget stops before a second provider call and preserves first usage", async () => {
    const claimed = syntheticClaimed();
    let budget = true;
    let recorded = 0;
    const provider = new SyntheticProvider([() => {
      budget = false;
      return { body: null, needsAnotherCall: true, usage: { status: "actual", inputTokens: 7, outputTokens: 3 } };
    }]);
    const outcome = await executeClaimedLearnerAnalysis(syntheticExecution(claimed), {
      provider,
      budgetAvailable: () => budget,
      recordModelCall: () => { recorded += 1; },
      releaseModelCall: () => { recorded -= 1; },
      readCurrent: () => syntheticCurrent(claimed),
      now: () => 1_000,
    });
    assert.equal(outcome.outcome, "budget_exhausted");
    assert.equal(outcome.calls, 1);
    assert.deepEqual(outcome.usage, { status: "actual", inputTokens: 7, outputTokens: 3 });
    assert.equal(recorded, 1);
    assert.equal(provider.calls.length, 1);
  });

  await t.test("an already exhausted cross-worker ledger makes no provider call", async () => {
    const claimed = syntheticClaimed({ attemptCount: 3 });
    const provider = new SyntheticProvider([]);
    const outcome = await executeClaimedLearnerAnalysis(syntheticExecution(claimed), {
      provider,
      budgetAvailable: () => true,
      recordModelCall: () => assert.fail("no call may be recorded"),
      releaseModelCall: () => assert.fail("no call may be released"),
      readCurrent: () => syntheticCurrent(claimed),
      now: () => 1_000,
    });
    assert.equal(outcome.outcome, "budget_exhausted");
    assert.equal(outcome.calls, 0);
    assert.equal(provider.calls.length, 0);
  });

  await t.test("stale lease and passive capture changes stop before the provider", async () => {
    for (const changed of [
      { leaseToken: "different-lease" },
      { captureRevision: 2 },
    ]) {
      const claimed = syntheticClaimed();
      const provider = new SyntheticProvider([]);
      const outcome = await executeClaimedLearnerAnalysis(syntheticExecution(claimed), {
        provider,
        budgetAvailable: () => true,
        recordModelCall: () => assert.fail("no call may be recorded"),
        releaseModelCall: () => assert.fail("no call may be released"),
        readCurrent: () => ({ ...syntheticCurrent(claimed), ...changed }),
        now: () => 1_000,
      });
      assert.equal(outcome.outcome, "stale");
      assert.equal(outcome.calls, 0);
    }
  });

  await t.test("explicit analysis survives a capture-only change while preserving unknown", async () => {
    const claimed = syntheticClaimed({ purpose: "explicit_analysis" });
    const provider = new SyntheticProvider([{ body: syntheticBody() }]);
    const outcome = await executeClaimedLearnerAnalysis(syntheticExecution(claimed), {
      provider,
      budgetAvailable: () => true,
      recordModelCall() {},
      releaseModelCall() {},
      readCurrent: () => ({ ...syntheticCurrent(claimed), captureRevision: 9 }),
      now: () => 1_000,
    });
    assert.equal(outcome.outcome, "success");
  });

  await t.test("provider failure keeps unknown usage and cancellation sends nothing", async () => {
    const failed = syntheticClaimed({ purpose: "explicit_analysis" });
    const failure = await executeClaimedLearnerAnalysis(syntheticExecution(failed), {
      provider: new SyntheticProvider([new Error("synthetic provider failure")]),
      budgetAvailable: () => true,
      recordModelCall() {},
      releaseModelCall() {},
      readCurrent: () => syntheticCurrent(failed),
      now: () => 1_000,
    });
    assert.equal(failure.outcome, "unavailable");
    assert.equal(failure.calls, 1);
    assert.deepEqual(failure.usage, { status: "unknown" });

    const cancelled = syntheticClaimed({ purpose: "explicit_analysis" });
    const controller = new AbortController();
    controller.abort();
    const provider = new SyntheticProvider([]);
    const outcome = await executeClaimedLearnerAnalysis({ ...syntheticExecution(cancelled), signal: controller.signal }, {
      provider,
      budgetAvailable: () => true,
      recordModelCall: () => assert.fail("no call may be recorded"),
      releaseModelCall: () => assert.fail("no call may be released"),
      readCurrent: () => syntheticCurrent(cancelled),
      now: () => 1_000,
    });
    assert.equal(outcome.outcome, "cancelled");
    assert.equal(provider.calls.length, 0);
  });

  await t.test("an input preflight rejection releases the unsent persistent reservation", async () => {
    const claimed = syntheticClaimed({ purpose: "explicit_analysis" });
    let reservations = 0;
    const outcome = await executeClaimedLearnerAnalysis(syntheticExecution(claimed), {
      provider: { async generate() { throw new InputLimitError(16_001); } },
      budgetAvailable: () => true,
      recordModelCall: () => { reservations += 1; },
      releaseModelCall: () => { reservations -= 1; },
      readCurrent: () => syntheticCurrent(claimed),
      now: () => 1_000,
    });
    assert.equal(outcome.outcome, "needs_input");
    assert.equal(outcome.calls, 0);
    assert.equal(reservations, 0);
  });
});

test("B3 uses the approved DeepSeek analysis schema through an injected offline invoker", async () => {
  const claimed = syntheticClaimed({ purpose: "explicit_analysis" });
  let invocation: Parameters<Parameters<typeof createDeepSeekProvider>[0]["invoke"]>[0] | undefined;
  const provider = createDeepSeekProvider({
    async invoke(request) {
      invocation = request;
      return { body: syntheticBody(), usage: { status: "actual", inputTokens: 19, outputTokens: 11 } };
    },
  });
  const outcome = await executeClaimedLearnerAnalysis(syntheticExecution(claimed), {
    provider,
    budgetAvailable: () => true,
    recordModelCall() {},
    releaseModelCall() {},
    readCurrent: () => syntheticCurrent(claimed),
    now: () => 1_000,
  });
  assert.equal(outcome.outcome, "success");
  assert.ok(invocation);
  assert.equal(invocation.schemaKind, "learner_analysis");
  assert.equal(invocation.model, "deepseek-flash");
  assert.equal(invocation.maxRetries, 0);
  assert.equal(invocation.maxOutputTokens, 4096);
  assert.deepEqual(invocation.providerOptions, { deepseek: { thinking: { type: "disabled" } } });
  assert.equal(invocation.purpose, "learner_analysis");
});

function analysisRuntime(
  s: Awaited<ReturnType<typeof setup>>,
  claimed: ClaimedLearnerAnalysis,
  provider: ModelProvider,
) {
  return {
    provider,
    budgetAvailable: () => true,
    now: () => s.f.timestamp(),
    recordModelCall() {
      s.f.db.withTransaction((tx) => {
        const job = readRecords(tx, claimed.binding.scope.courseId).jobs.find((item) => item.jobId === claimed.job.jobId);
        assert.ok(job);
        saveJob(tx, recordModelCall(job, claimed.leaseToken, claimed.job.recoveryGeneration, new Date(s.f.timestamp()).toISOString()));
      });
    },
    releaseModelCall() {
      s.f.db.withTransaction((tx) => {
        const job = readRecords(tx, claimed.binding.scope.courseId).jobs.find((item) => item.jobId === claimed.job.jobId);
        assert.ok(job);
        assert.equal(job.leaseToken, claimed.leaseToken);
        assert.ok(job.attemptCount > 0);
        saveJob(tx, { ...job, attemptCount: job.attemptCount - 1 });
      });
    },
    readCurrent(): LearnerAnalysisCurrentState {
      return s.f.db.withTransaction((tx) => {
        const scope = claimed.binding.scope;
        const job = readRecords(tx, scope.courseId).jobs.find((item) => item.jobId === claimed.job.jobId);
        assert.ok(job);
        const attempt = readAttempt(tx, scope.attemptId);
        const state = s.f.review.readCurrentInTransaction(tx, scope);
        const context = readContext(tx, scope);
        const activity = readActivity(tx, scope.courseId, attempt.activityVersionId);
        return {
          jobStatus: job.status,
          stopRequested: job.stopRequested,
          ...(job.leaseToken ? { leaseToken: job.leaseToken } : {}),
          ...(job.leaseUntil ? { leaseUntil: job.leaseUntil } : {}),
          recoveryGeneration: job.recoveryGeneration,
          attemptRevision: attempt.attemptRevision,
          decisionEpoch: attempt.decisionEpoch,
          learnerStateRevision: state.learnerStateRevision,
          contextRevision: context.contextRevision,
          captureRevision: attempt.captureRevision,
          activityVersionId: attempt.activityVersionId,
          policyVersionId: activity.helpPolicy.versionId,
          versions: structuredClone(claimed.binding.versions),
        };
      });
    },
  };
}

function syntheticClaimed(overrides: Partial<ClaimedLearnerAnalysis["job"]> = {}): ClaimedLearnerAnalysis {
  const purpose = overrides.purpose ?? "passive_analysis";
  const job = {
    jobId: "analysis-job",
    kind: "learner_analysis",
    purpose,
    scope: { courseId: "course", studentId: "student", attemptId: "attempt" },
    requestReceiptId: "receipt",
    status: "running" as const,
    stopRequested: false,
    expectedRevision: 1,
    decisionEpoch: 2,
    recoveryGeneration: "generation",
    acceptedAt: new Date(1_000).toISOString(),
    deadline: new Date(46_000).toISOString(),
    attemptCount: 0,
    leaseToken: "lease",
    leaseUntil: new Date(46_000).toISOString(),
    ...overrides,
  };
  return {
    job,
    leaseToken: "lease",
    binding: {
      scope: { courseId: "course", studentId: "student", attemptId: "attempt" },
      expectedStateRevision: 0,
      expectedAttemptRevision: 1,
      decisionEpoch: 2,
      contextRevision: 0,
      captureRevision: 1,
      activityVersionId: "activity",
      policyVersionId: "policy",
      collectionPurpose: purpose as "explicit_analysis" | "passive_analysis",
      versions: {
        modelConfigVersion: "model",
        promptVersion: "prompt",
        schemaVersion: "schema",
        analysisVersion: "analysis",
      },
      inputRefs: [{ kind: "snapshot", id: "snapshot", attemptId: "attempt" }],
      assistanceRefs: [],
      coverageRefs: [],
    },
  };
}

function syntheticCurrent(claimed: ClaimedLearnerAnalysis): LearnerAnalysisCurrentState {
  return {
    jobStatus: "running",
    stopRequested: false,
    leaseToken: claimed.leaseToken,
    leaseUntil: claimed.job.leaseUntil!,
    recoveryGeneration: "generation",
    attemptRevision: 1,
    decisionEpoch: 2,
    learnerStateRevision: 0,
    contextRevision: 0,
    captureRevision: 1,
    activityVersionId: "activity",
    policyVersionId: "policy",
    versions: structuredClone(claimed.binding.versions),
  };
}

function syntheticExecution(claimed: ClaimedLearnerAnalysis) {
  return {
    claimed,
    targets: [{
      competencyId: "k",
      competencyVersion: 1,
      domain: "domain" as const,
      scope: { kind: "activity" as const, activityVersionId: "activity" },
    }],
    references: [{ id: "snapshot", content: "Synthetic untrusted snapshot" }],
  };
}

function syntheticBody() {
  return {
    kind: "learner_analysis",
    claims: [{
      competencyId: "k",
      competencyVersion: 1,
      domain: "domain",
      scope: { kind: "activity", activityVersionId: "activity" },
      statement: "An explanation is not yet observed.",
      state: "insufficient",
      evidenceIds: ["snapshot"],
      counterEvidenceIds: [],
      assistanceStatus: "unknown",
      unresolved: true,
      unknown: ["No independent explanation"],
    }],
  };
}
