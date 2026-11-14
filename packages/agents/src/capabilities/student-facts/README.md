# Explicit student facts

`createStudentFacts` is a read-only source-owner projection. It shares the existing conservative extraction, topic, scope and correction algorithms; it does not infer ability or create a learning profile. There are no fact tables, migrations, teaching events, SQL reads or extra input writers. Facts retain their original input version, event/sequence/time, session/run, Agent owner, learning target and fixed input digest. Reads do not confirm preferences; later explicit corrections retain replacement links.

```ts
import { createStudentFacts } from '@xunjie/agents/capabilities/student-facts/index';

const studentFacts = createStudentFacts({
  activity: (identity, activityId) => currentLearningOwner.open(identity, activityId),
  sources: async identity => [{
    sourceId: 'current-source', identity, target: learningTarget,
    learning: learningOwner,             // public list/open; authorizes each read
    sessions: sessionDirectory,          // public list/read; preserves the fixed owner
    core: session => originalAgent(session),
  }],
});
```

Pass `studentFacts` to the existing `WorkspaceToolOptions.studentFacts`. Its optional `read_student_facts` capability keeps the same name and required `current-activity`/`same-course` scope, and remains callable through fixed remote tool modules. Assemble it on the data owner, then expose those tool modules to an Agent-only deployment; that Agent needs no learning database access. `core(session)` must resolve the exact fresh directory owner, never substitute an available Agent. It may return native public `sessionSnapshot/events` or the existing Agent v2 `conversation/snapshot/events` client. No new RPC is required.

The reader uses the current workspace plus same-course course-scoped facts and explicit global preferences. Other-course activity/course preferences remain excluded. Personal continuation remains ambiguous unless the original activity text explicitly continues the same goal, as in the prior implementation. Query filtering and the 100-fact result envelope are unchanged. Only user input text is extracted: works, material/retrieval context, assistant text, progress, summaries and tool results are excluded.

The directory and learning source are reauthorized before publishing. Events are paged at the original core, correlated with current input versions, and guarded by matching before/after public snapshots. Missing evidence, changing input versions, foreign subjects or redirected owners fail instead of returning a partially reconstructed correction history. Removed inputs and deleted sessions produce no active preferences. Recovery of an already completed tool continues to use its original core result; the fact reader is not a replacement-request engine.
