import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  StudentHelpBody,
  StudentHelpRequest,
  TeacherGenerationRequest,
  TrustedModelContext,
} from "../../../contracts/tutoring/index.ts";
import { generateStudentHelp, generateTeacherProposal } from "../core.ts";
import { createAiSdkDeepSeekInvoker, createAiSdkDeepSeekProvider } from "../deepseek-sdk.ts";
import {
  createDeepSeekProvider,
  estimateDeepSeekInputTokenUpperBound,
  type DeepSeekInvocation,
} from "../providers.ts";

function context(overrides: Partial<TrustedModelContext> = {}): TrustedModelContext {
  const acceptedAtMs = Date.now();
  return {
    jobId: "job-sdk-1",
    purpose: "student_help",
    scope: { courseId: "course-1", userId: "student-1", attemptId: "attempt-1" },
    authorizedReferenceIds: ["resource-1"],
    acceptedAtMs,
    deadlineAtMs: acceptedAtMs + 45_000,
    budgetAvailable: true,
    versions: { modelConfig: "deepseek-flash-v1", prompt: "prompt-v1", schema: "schema-v1", policy: "policy-v1" },
    ...overrides,
  };
}

function request(overrides: Partial<StudentHelpRequest> = {}): StudentHelpRequest {
  return {
    context: context(),
    question: "Give one bounded hint",
    references: [{ id: "resource-1", content: "Approved material" }],
    policy: { helpAllowed: true, wholeSolutionAllowed: false },
    ...overrides,
  };
}

function validBody(overrides: Partial<StudentHelpBody> = {}): StudentHelpBody {
  return {
    kind: "student_help",
    actionType: "hint",
    content: "Identify the delimiter condition first.",
    rationale: "A bounded hint answers the request.",
    expectedStudentAction: "Write the delimiter predicate.",
    evidenceIds: [],
    resourceRefs: ["resource-1"],
    assistanceContext: "one bounded hint",
    unresolved: [],
    policyChecks: {
      containsWholeSolution: false,
      writesStudentWork: false,
      runsCode: false,
      makesFormalEvaluation: false,
    },
    ...overrides,
  };
}

function sdkProvider(
  fetch: NonNullable<Parameters<typeof createAiSdkDeepSeekInvoker>[0]["fetch"]>,
  onInvocation?: (invocation: DeepSeekInvocation) => void,
) {
  const invoke = createAiSdkDeepSeekInvoker({
    apiKey: "offline-test-key",
    baseURL: "https://offline.invalid/v1",
    fetch,
  });
  return createDeepSeekProvider({
    invoke: async (invocation) => {
      onInvocation?.(invocation);
      return invoke(invocation);
    },
  });
}

function completion(body: unknown, includeUsage = true): Response {
  return completionText(JSON.stringify(body), includeUsage
    ? { promptTokens: 23, completionTokens: 11 }
    : undefined);
}

function completionText(
  content: string,
  usage: { promptTokens: number; completionTokens: number } | undefined,
): Response {
  return Response.json({
    id: "offline-completion",
    created: 1,
    model: "deepseek-flash",
    object: "chat.completion",
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
      logprobs: null,
    }],
    ...(usage === undefined ? {} : {
      usage: {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        total_tokens: usage.promptTokens + usage.completionTokens,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: usage.promptTokens,
      },
    }),
  });
}

test("AI SDK adapter maps approved DeepSeek settings through an offline transport", async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  let invocation: DeepSeekInvocation | undefined;
  const provider = sdkProvider(async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return completion(validBody());
  }, (value) => { invocation = value; });

  const result = await generateStudentHelp(request(), { provider });
  assert.equal(result.outcome, "success");
  assert.deepEqual(result.usage, { status: "actual", inputTokens: 23, outputTokens: 11 });
  assert.equal(requests.length, 1);
  assert.match(requests[0]?.url ?? "", /offline\.invalid\/v1\/chat\/completions$/);
  assert.equal(requests[0]?.body.model, "deepseek-flash");
  assert.equal(requests[0]?.body.max_tokens, 4096);
  assert.deepEqual(requests[0]?.body.thinking, { type: "disabled" });
  assert.equal("tools" in (requests[0]?.body ?? {}), false);
  assert.equal((requests[0]?.body.response_format as { type?: string }).type, "json_object");
  const systemText = (requests[0]?.body.messages as { role: string; content: string }[])
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  assert.match(systemText, /Return JSON that conforms to the following schema/);
  assert.ok(invocation);
  assert.ok(
    estimateDeepSeekInputTokenUpperBound(invocation) >=
      Buffer.byteLength(JSON.stringify(requests[0]?.body), "utf8"),
  );
});

test("invalid structured policy output reaches the one permitted repair request", async () => {
  const requestBodies: Record<string, unknown>[] = [];
  const responses = [
    completion(validBody({
      policyChecks: {
        containsWholeSolution: true,
        writesStudentWork: false,
        runsCode: false,
        makesFormalEvaluation: false,
      } as never,
    })),
    completion(validBody()),
  ];
  const provider = sdkProvider(async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const response = responses.shift();
    assert.ok(response);
    return response;
  });

  const result = await generateStudentHelp(request(), { provider });
  assert.equal(result.outcome, "success");
  assert.equal(result.calls, 2);
  assert.equal(requestBodies.length, 2);
  const firstSystem = (requestBodies[0]?.messages as { role: string; content: string }[])
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  const repairedSystem = (requestBodies[1]?.messages as { role: string; content: string }[])
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  assert.doesNotMatch(firstSystem, /single permitted repair attempt/);
  assert.match(repairedSystem, /single permitted repair attempt/);
});

test("malformed SDK JSON preserves usage and reaches the one permitted repair", async () => {
  const requestBodies: Record<string, unknown>[] = [];
  const responses = [
    completionText('{"kind":', { promptTokens: 23, completionTokens: 11 }),
    completion(validBody()),
  ];
  const provider = sdkProvider(async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const response = responses.shift();
    assert.ok(response);
    return response;
  });

  const result = await generateStudentHelp(request(), { provider });
  assert.equal(result.outcome, "success");
  assert.equal(result.calls, 2);
  assert.deepEqual(result.usage, { status: "actual", inputTokens: 46, outputTokens: 22 });
  assert.equal(requestBodies.length, 2);
  const repairedSystem = (requestBodies[1]?.messages as { role: string; content: string }[])
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  assert.match(repairedSystem, /single permitted repair attempt/);
});

test("negative SDK token usage is kept unknown", async () => {
  const provider = sdkProvider(async () =>
    completionText(JSON.stringify(validBody()), { promptTokens: -23, completionTokens: 11 }));

  const result = await generateStudentHelp(request(), { provider });
  assert.equal(result.outcome, "success");
  assert.equal(result.calls, 1);
  assert.deepEqual(result.usage, { status: "unknown" });
});

test("SDK-valid but unauthorized references are repaired by the B1 whitelist", async () => {
  let calls = 0;
  const provider = sdkProvider(async () => {
    calls += 1;
    return completion(calls === 1
      ? validBody({ resourceRefs: ["model-invented-reference"] })
      : validBody());
  });

  const result = await generateStudentHelp(request(), { provider });
  assert.equal(result.outcome, "success");
  assert.equal(result.calls, 2);
  assert.equal(calls, 2);
});

test("AI SDK adapter selects the teacher mode schema and returns a proposal body", async () => {
  let wireBody: Record<string, unknown> | undefined;
  const provider = sdkProvider(async (_input, init) => {
    wireBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return completion({
      kind: "candidates",
      candidates: [{
        problem: "Analyze text",
        audience: "C learners",
        artifact: "TextScope",
        routes: ["array"],
        goals: ["explain delimiters"],
        constraints: ["C17"],
        unresolved: [],
        resourceRefs: ["resource-1"],
      }],
    });
  });
  const teacherContext: TrustedModelContext = {
    ...context(),
    purpose: "teacher_design",
    scope: { courseId: "course-1", userId: "teacher-1" },
  };
  const teacherRequest: TeacherGenerationRequest = {
    context: teacherContext,
    mode: "candidates",
    request: "Design a project",
    references: [{ id: "resource-1", content: "Approved material" }],
  };

  const result = await generateTeacherProposal(teacherRequest, { provider });
  assert.equal(result.outcome, "success");
  assert.equal(result.body.kind, "candidates");
  assert.ok(wireBody);
  const systemText = (wireBody.messages as { role: string; content: string }[])
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  assert.match(systemText, /"const":"candidates"/);
  assert.match(systemText, /Allowed reference IDs: \["resource-1"\]/);
});

test("teacher patch sends trusted reference and exact allowed-field guidance", async () => {
  let invocation: DeepSeekInvocation | undefined;
  const provider = sdkProvider(async () => completion({
    kind: "patch",
    changes: [{ field: "problem", value: "Check ASCII boundaries explicitly." }],
    rationale: "Keep the change local and teacher-reviewable.",
    resourceRefs: ["resource-1"],
    affectedLinks: [],
    unresolved: [],
  }), value => { invocation = value; });
  const teacherContext: TrustedModelContext = {
    ...context(),
    purpose: "teacher_design",
    scope: { courseId: "course-1", userId: "teacher-1" },
  };

  const result = await generateTeacherProposal({
    context: teacherContext,
    mode: "patch",
    request: JSON.stringify({ teacherRequest: "Improve only the problem", allowedFields: ["problem"] }),
    references: [{ id: "resource-1", content: "Approved material" }],
    blueprintId: "blueprint-1",
    baseRevision: 1,
  }, { provider });

  assert.equal(result.outcome, "success");
  assert.ok(invocation);
  assert.match(invocation.system, /Allowed reference IDs: \["resource-1"\]/);
  assert.match(invocation.system, /PATCH changes\[\]\.field: exact allowedFields item only/);
  assert.match(invocation.system, /allowedFields/);
});

test("AI SDK adapter keeps missing vendor usage unknown", async () => {
  const provider = createAiSdkDeepSeekProvider({
    apiKey: "offline-test-key",
    baseURL: "https://offline.invalid/v1",
    fetch: async () => completion(validBody(), false),
  });
  const result = await generateStudentHelp(request(), { provider });
  assert.equal(result.outcome, "success");
  assert.deepEqual(result.usage, { status: "unknown" });
});

test("AI SDK adapter reports vendor failure without retrying", async () => {
  let calls = 0;
  const provider = sdkProvider(async () => {
    calls += 1;
    return Response.json({ error: { message: "offline failure", type: "test" } }, { status: 503 });
  });
  const result = await generateStudentHelp(request(), { provider });
  assert.equal(result.outcome, "unavailable");
  assert.equal(result.calls, 1);
  assert.equal(calls, 1);
  assert.deepEqual(result.usage, { status: "unknown" });
});

test("AI SDK adapter cancellation aborts a pending offline transport", async () => {
  const controller = new AbortController();
  let calls = 0;
  const provider = sdkProvider(async (_input, init) => {
    calls += 1;
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  });
  const pending = generateStudentHelp(request({ signal: controller.signal }), { provider });
  setTimeout(() => controller.abort(), 5);
  const result = await pending;
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.calls, 1);
  assert.equal(calls, 1);
});

test("late SDK transport completion is discarded after the shared deadline", async () => {
  const acceptedAtMs = Date.now();
  let calls = 0;
  const provider = sdkProvider(async () => {
    calls += 1;
    return await new Promise<Response>((resolve) => {
      setTimeout(() => resolve(completion(validBody())), 30);
    });
  });
  const result = await generateStudentHelp(request({
    context: context({ acceptedAtMs, deadlineAtMs: acceptedAtMs + 10 }),
  }), { provider });
  assert.equal(result.outcome, "timed_out");
  assert.equal(result.calls, 1);
  assert.equal(calls, 1);
});

test("16K preflight rejects the complete final SDK input before transport", async () => {
  let calls = 0;
  const provider = sdkProvider(async () => {
    calls += 1;
    return completion(validBody());
  });
  const result = await generateStudentHelp(request({ question: "资料".repeat(10_000) }), { provider });
  assert.equal(result.outcome, "needs_input");
  assert.equal(result.code, "INPUT_LIMIT_EXCEEDED");
  assert.equal(result.calls, 0);
  assert.equal(calls, 0);
});
