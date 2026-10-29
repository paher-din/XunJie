import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Transaction } from '../server/db/transaction.ts';
import { teacherDesignAgentOptions, teacherDesignRoundCalls } from '../server/app/personal-models.ts';
import { ProviderCallNotStartedError } from '../server/tutoring/providers.ts';
import type { CompatibleTransport, ModelSelection, PersonalAgentService } from '../server/personal-agent/types.ts';

// The approval the lead confirmed for the first demonstration round.
const approval = {
  allowedTeacherIds: ['teacher-a'], allowedCourseIds: ['course-a'],
  maximumCallsPerRequest: 1, maximumCallsPerRound: 3, maximumOutputTokens: 4096,
  roundStartsAtMs: Date.parse('2026-10-15T00:00:00Z'),
};
const approvedSelection: ModelSelection = {
  userId: 'teacher-a', version: 'personal-v7', providerId: 'p-1', baseUrl: 'https://provider.example/v1',
  model: 'mimo-v2.6-flash', apiKey: 'synthetic-key', contextWindow: 20096, maxOutputTokens: 4096,
};

/** A transaction whose queries return nothing: no round rows, so the round budget is untouched. */
const emptyTx = { all: () => [] } as unknown as Transaction;
/** The personal model service is keyed per user; only the supplied selection exists. */
function personalService(selection?: ModelSelection): PersonalAgentService {
  return { register: () => {}, selection: userId => (selection && selection.userId === userId ? selection : undefined),
    configurationRevision: () => 1, close: async () => {} };
}
const transport = {} as CompatibleTransport;
function gates(options: { selection?: ModelSelection; callsEnabled?: boolean } = {}) {
  return teacherDesignAgentOptions({ service: personalService(options.selection), transport,
    personalCallsEnabled: () => options.callsEnabled !== false, approval });
}
const context = (overrides: Partial<{ actorId: string; courseId: string; usages: readonly { status: 'unknown' }[] }> = {}) =>
  ({ actorId: 'teacher-a', courseId: 'course-a', usages: [], ...overrides });

test('teacher design calls stay off until every approved value holds', () => {
  const denied = gates({ selection: approvedSelection }).budgetAvailableInTransaction!;
  // approved teacher, course, personal switch, selection and room in both limits
  assert.equal(denied(emptyTx, context()), true, 'the fully approved case must allow one call');
  assert.equal(denied(emptyTx, context({ actorId: 'teacher-b' })), false, 'an unapproved teacher must be refused');
  assert.equal(denied(emptyTx, context({ courseId: 'course-b' })), false, 'an unapproved course must be refused');
  // the per-request limit is already used up by the last reservation
  assert.equal(denied(emptyTx, context({ usages: [{ status: 'unknown' }] })), false,
    'the per-request limit must refuse a second call, including an unconfirmed one');
  assert.equal(gates({ selection: approvedSelection, callsEnabled: false }).budgetAvailableInTransaction!(emptyTx, context()), false,
    'disabling personal calls must refuse teacher design calls');
  assert.equal(gates({}).budgetAvailableInTransaction!(emptyTx, context()), false,
    'a teacher without a personal selection must be refused without calling');
  const tooLarge = { ...approvedSelection, maxOutputTokens: 8192 };
  assert.equal(gates({ selection: tooLarge }).budgetAvailableInTransaction!(emptyTx, context()), false,
    'a configured output ceiling above the approved one must be refused');
  const withinApproval: ModelSelection = { userId: 'teacher-a', version: 'personal-v7', providerId: 'p-1',
    baseUrl: 'https://provider.example/v1', model: 'mimo-v2.6-flash', apiKey: 'synthetic-key', contextWindow: 20096 };
  assert.equal(gates({ selection: withinApproval }).budgetAvailableInTransaction!(emptyTx, context()), true,
    'an unset ceiling falls back to the approved default');
});

test('the round ledger counts original request rows and ignores rows outside the round', () => {
  // No job row is associated with this request, so it cannot be placed in the round: it is not counted.
  const rowWithoutJob = { all: (sql: string) => (/teacher_design_requests/.test(sql)
    ? [{ job_id: 'job-outside', usage_json: '[{"status":"unknown"}]' }] : []) } as unknown as Transaction;
  assert.equal(teacherDesignRoundCalls(rowWithoutJob, 'teacher-a', 'course-a', approval.roundStartsAtMs), 0);
  assert.equal(teacherDesignRoundCalls(emptyTx, 'teacher-a', 'course-a', approval.roundStartsAtMs), 0);
});

test('the personal model version is bound to the teacher and unconfigured stays explicit', () => {
  const versionsFor = gates({ selection: approvedSelection }).versionsForTeacher!;
  assert.equal(versionsFor({ actorId: 'teacher-a', courseId: 'course-a' }).modelConfig, 'personal-v7');
  assert.equal(versionsFor({ actorId: 'teacher-b', courseId: 'course-a' }).modelConfig, 'personal-unconfigured',
    'a teacher without a selection reports the explicit unconfigured value');
});

test('dispatch refuses a missing or changed personal model instead of reusing another configuration', () => {
  const providerFor = gates({ selection: approvedSelection }).providerForTeacher!;
  assert.ok(providerFor({ actorId: 'teacher-a', courseId: 'course-a', modelConfig: 'personal-v7' }),
    'the bound version resolves a provider');
  for (const [modelConfig, outcome] of [['personal-v6', 'stale'], ['personal-v7', 'unavailable']] as const) {
    const actorId = outcome === 'stale' ? 'teacher-a' : 'teacher-b';
    let thrown: unknown;
    try { providerFor({ actorId, courseId: 'course-a', modelConfig }); } catch (error) { thrown = error; }
    assert.ok(thrown instanceof ProviderCallNotStartedError, `${outcome} must refuse before dispatch`);
    assert.equal((thrown as ProviderCallNotStartedError).outcome, outcome);
  }
});
