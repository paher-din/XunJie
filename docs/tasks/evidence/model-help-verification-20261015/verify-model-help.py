"""Read-only assertions for the two explicitly authorized synthetic help requests."""
import datetime
import json
import sqlite3
import sys

DATABASE = '/opt/xunjie-runner/tests/i0-entry-20261013-01/retained-tmp-20261014/xunjie-a12-completion-dZlbr9/synthetic.sqlite'
HOST_LOG = '/opt/xunjie-runner/tests/teacher-student-link-9664ca5-20261015/host-retained.log'
CASES = {
    'c': ('a60e1238-d9a7-4658-8f54-882b61ebf3c6', '7f73aec2-e4b2-40d2-89a1-58f404ed2079'),
    'hdl': ('b81973b2-dde4-4019-98d9-b4f26b036b13', '3c75dbe4-56f1-4fe3-897b-ac102b1c52aa'),
}
connection = sqlite3.connect('file:' + DATABASE + '?mode=ro', uri=True)
connection.row_factory = sqlite3.Row
connection.execute('PRAGMA query_only=ON')
connection.execute('BEGIN')
result = {
    'observedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'sourceCommit': '9664ca5646b969cde0ccff4f4b8d5c7ea2da547d',
    'scope': 'Synthetic project help; not independent chat, real learning or full semantic/NFR acceptance',
    'integrity': connection.execute('PRAGMA integrity_check').fetchone()[0],
    'foreignKeyErrors': len(connection.execute('PRAGMA foreign_key_check').fetchall()),
    'tableCount': connection.execute("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchone()[0],
    'control': dict(connection.execute('SELECT recovery_generation,control_revision FROM application_control WHERE singleton=1').fetchone()),
    'cases': [],
}
assert result['integrity'] == 'ok' and result['foreignKeyErrors'] == 0 and result['tableCount'] == 41
assert result['control'] == {'recovery_generation': 'synthetic-generation-96fc2f60-8102-47fb-af1f-e2d86f4c2764', 'control_revision': 2}
for kind, (assignment_id, job_id) in CASES.items():
    attempts = connection.execute('SELECT * FROM attempts WHERE assignment_id=?', (assignment_id,)).fetchall()
    assert len(attempts) == 1 and attempts[0]['student_id'] == 'synthetic-i0-student-b'
    attempt = attempts[0]
    state = json.loads(attempt['attempt_json'])
    assert state['status'] == 'active' and state['workspaceRevision'] == 0
    jobs = connection.execute('SELECT * FROM jobs WHERE attempt_id=?', (attempt['attempt_id'],)).fetchall()
    assert len(jobs) == 1 and jobs[0]['job_id'] == job_id and jobs[0]['purpose'] == 'student_help' and jobs[0]['status'] == 'succeeded'
    job = json.loads(jobs[0]['job_json'])
    messages = connection.execute('SELECT * FROM teaching_messages WHERE job_id=?', (job_id,)).fetchall()
    assert len(messages) == 2 and {row['author_kind'] for row in messages} == {'student', 'model'}
    message = next(row for row in messages if row['author_kind'] == 'model')
    envelope = json.loads(message['message_json'])['envelope']
    assert envelope['calls'] == 1 and 0 <= envelope['elapsedMs'] <= 45000
    assert envelope['usage']['status'] == 'actual' and envelope['versions']['modelConfigVersion'] == 'deepseek-flash-v1'
    actions = connection.execute('SELECT * FROM teaching_actions WHERE job_id=?', (job_id,)).fetchall()
    assert len(actions) == 1 and actions[0]['message_id'] == message['message_id']
    action = actions[0]
    receipts = [dict(row) for row in connection.execute('SELECT r.receipt_kind,r.server_seq,e.committed_at_ms FROM teaching_action_receipts r JOIN audit_events e ON e.server_seq=r.server_seq WHERE r.action_id=? ORDER BY r.server_seq', (action['action_id'],))]
    assert {row['receipt_kind'] for row in receipts} >= {'received', 'displayed'}
    assert not {row['receipt_kind'] for row in receipts} & {'failed', 'cancelled', 'stale', 'acknowledged'}
    accepted_ms = datetime.datetime.fromisoformat(job['acceptedAt'].replace('Z', '+00:00')).timestamp() * 1000
    displayed_ms = next(row['committed_at_ms'] for row in receipts if row['receipt_kind'] == 'displayed')
    counts = {table: connection.execute('SELECT count(*) FROM ' + table + ' WHERE attempt_id=?', (attempt['attempt_id'],)).fetchone()[0] for table in ['workspace_files', 'artifact_snapshots', 'workspace_runs', 'workspace_submissions', 'hdl_builds', 'hdl_sessions']}
    assert not any(counts.values())
    result['cases'].append({
        'kind': kind, 'assignmentId': assignment_id, 'attemptId': attempt['attempt_id'],
        'attemptStatus': state['status'], 'attemptRevision': attempt['attempt_revision'], 'workspaceRevision': state['workspaceRevision'],
        'jobId': job_id, 'jobStatus': jobs[0]['status'], 'actionId': action['action_id'],
        'messageId': message['message_id'], 'contentHash': message['content_hash'],
        'versions': envelope['versions'], 'calls': envelope['calls'], 'usage': envelope['usage'],
        'modelElapsedMs': envelope['elapsedMs'], 'acceptedAt': job['acceptedAt'],
        'displayedReceiptDelayMs': round(displayed_ms - accepted_ms), 'receipts': receipts,
        'replyContent': envelope['body']['content'], 'unchangedEmptyWork': counts,
    })
connection.close()
result['transport'] = []
with open(HOST_LOG, encoding='utf8') as log:
    for line in log:
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if value.get('kind') == 'model-http':
            result['transport'].append({key: value[key] for key in ['kind', 'status', 'elapsedMs']})
assert len(result['transport']) == 2 and all(row['status'] == 200 for row in result['transport'])
result['assertions'] = 'passed'
content = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
if len(sys.argv) == 2:
    with open(sys.argv[1], 'x', encoding='utf8') as output:
        output.write(content)
else:
    print(content, end='')
