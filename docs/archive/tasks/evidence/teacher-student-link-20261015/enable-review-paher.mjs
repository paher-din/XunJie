import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewSchema } from 'file:///opt/xunjie-runner/tests/teacher-student-link-9664ca5-20261015/apps/teaching/server/db/review-schema.ts';

// Current-task proposal: PAHER retained synthetic target only; --check is read-only. --apply requires fresh explicit approval.
const target = '/opt/xunjie-runner/tests/i0-entry-20261013-01/retained-tmp-20261014/xunjie-a12-completion-dZlbr9/synthetic.sqlite';
const ownedRoot = '/opt/xunjie-runner/tests/i0-entry-20261013-01';
const expected35 = ['activity_controls','activity_versions','application_control','artifact_snapshots','assignments','attempts','audit_events','blueprint_drafts','check_rule_versions','command_receipts','competency_versions','course_memberships','courses','digital_logic_config_versions','hdl_builds','hdl_operations','hdl_sessions','help_policy_versions','jobs','login_attempt_windows','resource_versions','sessions','teacher_design_proposals','teacher_design_requests','teaching_action_receipts','teaching_actions','teaching_deliveries','teaching_messages','users','workspace_command_bindings','workspace_files','workspace_process_records','workspace_reopen_grants','workspace_runs','workspace_submissions'];
const additional = ['analysis_results','learner_context_revisions','learner_disputes','learner_state_revisions','teacher_decisions','teacher_feedback'];
const expected41 = [...expected35, ...additional].sort();
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => !['--check','--apply'].includes(arg))) throw new Error('Use --check (default) or explicitly authorized --apply.');
const apply = args[0] === '--apply';
if (process.platform !== 'linux' || process.version !== 'v24.21.0') throw new Error('Prepared Linux Node24.21.0 required.');
const root = '/opt/xunjie-runner/tests/teacher-student-link-9664ca5-20261015';
const Driver = createRequire(resolve(root, 'apps/teaching/package.json'))('better-sqlite3');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const names = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
const exact = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
function ordinary(file) {
  if (!existsSync(file) || lstatSync(file).isSymbolicLink() || realpathSync(file) !== file) throw new Error('Ordinary retained target required.');
}
ordinary(ownedRoot); ordinary(dirname(target)); ordinary(target);
if (!lstatSync(target).isFile() || !target.startsWith(`${ownedRoot}/retained-tmp-20261014/`)) throw new Error('Unexpected database target.');
const db = new Driver(target, { readonly: !apply, fileMustExist: true });
let evidence, record;
const persist = () => { if (evidence && record) writeFileSync(`${evidence}/result.json`, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 }); };
try {
  const originalNames = names(db), integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok' || db.pragma('foreign_key_check').length) throw new Error('Existing database integrity failed.');
  if (!exact(originalNames, expected35)) throw new Error(`Expected exact 35-table source; found ${originalNames.length}. No migration performed.`);
  const users = db.prepare('SELECT id FROM users ORDER BY id').all().map(row => row.id);
  const courses = db.prepare('SELECT id FROM courses ORDER BY id').all().map(row => row.id);
  if (users.length !== 5 || !users.every(id => /^synthetic-i0-(teacher-[ab]|student-(a|b|peer))$/.test(id)) ||
      courses.length !== 2 || !courses.every(id => /^synthetic-i0-course-[ab]$/.test(id))) throw new Error('Owned synthetic identity mismatch.');
  const declared = [...reviewSchema.matchAll(/CREATE TABLE\s+([a-z_][a-z0-9_]*)/gi)].map(match => match[1]).sort();
  const indexes = [...reviewSchema.matchAll(/CREATE INDEX\s+([a-z_][a-z0-9_]*)/gi)].map(match => match[1]);
  if (!exact(declared, additional) || indexes.length !== 4 || /\b(?:DROP|ALTER|DELETE|UPDATE|INSERT|ATTACH|PRAGMA)\b/i.test(reviewSchema)) throw new Error('Review migration scope mismatch.');
  if (db.prepare("SELECT count(*) AS n FROM jobs WHERE status NOT IN ('succeeded','failed','stale','timed_out','cancelled')").get().n || db.prepare('SELECT count(*) AS n FROM hdl_sessions WHERE termination_confirmed<>1 OR pending_operation_id IS NOT NULL').get().n) throw new Error('Original tasks or HDL sessions remain in flight');
  const originalRowHashes = Object.fromEntries(expected35.map(name => [name,createHash('sha256').update(JSON.stringify(db.prepare('SELECT * FROM '+name).all().map(row=>JSON.stringify(row)).sort())).digest('hex')]));
  const base = { mode: apply ? 'apply' : 'check', databaseFile: target, sourceTableCount: 35, targetTableCount: 41,
    addedTables: additional, addedIndexes: indexes, integrity, foreignKeyViolations: 0, schemaSha256: createHash('sha256').update(reviewSchema).digest('hex') };
  if (!apply) console.log(JSON.stringify({ ...base, applied: false }));
  else {
    for (const pid of (await import('node:fs')).readdirSync('/proc').filter(p => /^\d+$/.test(p) && Number(p)!==process.pid)) { let descriptors; try { descriptors=(await import('node:fs')).readdirSync('/proc/'+pid+'/fd'); } catch { continue; } for (const descriptor of descriptors) { let link; try { link=(await import('node:fs')).readlinkSync('/proc/'+pid+'/fd/'+descriptor); } catch { continue; } if ([target,target+'-wal',target+'-shm'].includes(link)) throw new Error('Stop application/database users before apply'); } }
    const pidFile = '/opt/xunjie-runner/tests/teacher-student-link-9664ca5-20261015/retired-host.pid';
    if (existsSync(pidFile)) {
      const pid = readFileSync(pidFile, 'utf8').trim();
      if (/^[0-9]+$/.test(pid) && existsSync(`/proc/${pid}/cmdline`) &&
          readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('local-application-host.mjs')) throw new Error('Stop the owned local application host before migration.');
    }
    evidence = `${ownedRoot}/teacher-link-review-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    mkdirSync(evidence, { mode: 0o700 });
    const backup = `${evidence}/before.sqlite`;
    record = { ...base, applied: false, startedAtUtc: new Date().toISOString(), backupFile: backup,
      sourceFileSha256: hash(target), existingObjects: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
      existingCounts: Object.fromEntries(expected35.map(name => [name, db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n])) };
    closeSync(openSync(`${evidence}/result.json`, 'wx', 0o600)); persist();
    await db.backup(backup);
    const saved = new Driver(backup, { readonly: true, fileMustExist: true });
    try {
      for (const [table,beforeHash] of Object.entries(originalRowHashes)) if(createHash('sha256').update(JSON.stringify(saved.prepare('SELECT * FROM '+table).all().map(row=>JSON.stringify(row)).sort())).digest('hex')!==beforeHash) throw new Error('Backup original row content mismatch');
      if (!exact(names(saved), expected35) || saved.pragma('integrity_check', { simple: true }) !== 'ok' || saved.pragma('foreign_key_check').length) throw new Error('Backup integrity failed; source remains unchanged.');
    } finally { saved.close(); }
    record.backupSha256 = hash(backup); persist();
    db.pragma('foreign_keys=ON');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!exact(names(db), expected35)) throw new Error('Source schema changed during backup.');
      db.exec(reviewSchema);
      if (!exact(names(db), expected41)) throw new Error('Post-migration table scope mismatch.');
      const afterObjects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
      for (const before of record.existingObjects) if (!afterObjects.some(after => JSON.stringify(after) === JSON.stringify(before))) throw new Error('An existing schema object changed.');
      for (const [name, count] of Object.entries(record.existingCounts)) if (db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n !== count) throw new Error('Existing record count changed.');
      if (db.pragma('integrity_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length) throw new Error('Post-migration integrity failed.');
      for (const [table,beforeHash] of Object.entries(originalRowHashes)) {
        const afterHash=createHash('sha256').update(JSON.stringify(db.prepare('SELECT * FROM '+table).all().map(row=>JSON.stringify(row)).sort())).digest('hex');
        if(afterHash!==beforeHash)throw new Error('Existing row content changed');
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    record.originalRowHashes=originalRowHashes; record.originalRowsUnchanged=true; record.applied = true; record.finishedAtUtc = new Date().toISOString(); record.resultTableCount = names(db).length;
    record.integrityAfter = db.pragma('integrity_check', { simple: true }); record.foreignKeyViolationsAfter = db.pragma('foreign_key_check').length;
    persist(); console.log(JSON.stringify({ applied: true, databaseFile: target, tableCount: 41, evidenceDirectory: evidence, backupSha256: record.backupSha256 }));
  }
} catch (error) {
  if (record) { record.failure = error.message; record.failedAtUtc = new Date().toISOString(); persist(); }
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
} finally { db.close(); }
