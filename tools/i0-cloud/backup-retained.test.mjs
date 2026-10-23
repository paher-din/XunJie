import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createEncryptedBackup, restoreEncryptedBackup } from './backup-retained.mjs';

const REPOSITORY = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const TEACHING_ROOT = join(REPOSITORY, 'apps/teaching');
const sha256 = value => createHash('sha256').update(value).digest('hex');

function createSqliteFixture(path) {
  // Loaded from the teaching production dependencies, exactly like the server runtime does.
  const Driver = createRequire(join(TEACHING_ROOT, 'package.json'))('better-sqlite3');
  const db = new Driver(path);
  db.exec(`
    CREATE TABLE members (id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
    CREATE TABLE submissions (id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), content TEXT NOT NULL);
  `);
  db.prepare('INSERT INTO members VALUES (?, ?)').run('teacher', '教师');
  db.prepare('INSERT INTO submissions VALUES (?, ?, ?)').run('s1', 'teacher', '首次提交');
  db.close();
  return path;
}

function backupOptions(root, { label = 'daily', keep = 7 } = {}) {
  return {
    config: join(root, 'backup-config.json'), keyFile: join(root, 'backup.key'),
    label, keep,
  };
}

function writeBackupConfig(root, { personalModels = true, extraFiles = [] } = {}) {
  const directory = mkdtempSync(join(root, 'source-'));
  const courseDatabaseFile = createSqliteFixture(join(directory, 'synthetic.sqlite'));
  const settings = {
    courseDatabaseFile,
    personalModelsDirectory: '',
    extraFiles,
    outputDirectory: join(root, 'encrypted-backups'),
    teachingRoot: TEACHING_ROOT,
  };
  if (personalModels) {
    settings.personalModelsDirectory = join(directory, 'personal-models');
    mkdirSync(settings.personalModelsDirectory, { recursive: true });
    createSqliteFixture(join(settings.personalModelsDirectory, 'personal-agent.sqlite'));
    writeFileSync(join(settings.personalModelsDirectory, 'credentials.key'), 'model-store-key-material');
  }
  writeFileSync(join(root, 'backup-config.json'), JSON.stringify(settings));
  return { settings, directory };
}

test('encrypted backup covers business data and recovery materials, then restores in isolation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xunjie-backup-test-'));
  try {
    writeFileSync(join(root, 'backup.key'), 'fixture-maintainer-key-material');
    writeFileSync(join(root, 'signing-secret.txt'), 'signing-secret-value');
    const { settings } = writeBackupConfig(root, { extraFiles: [join(root, 'signing-secret.txt')] });
    const result = await createEncryptedBackup(backupOptions(root));
    assert.equal(result.status, 'created');
    const archive = result.path;
    assert.match(archive, /daily-\d{8}T\d{6}Z-[0-9a-f]{8}\.xunjiebak$/);
    assert.equal(statSync(archive).mode & 0o077, 0);
    assert.deepEqual(result.files, ['course/synthetic.sqlite', 'personal-models/credentials.key',
      'personal-models/personal-agent.sqlite', 'extra/signing-secret.txt']);
    assert.equal(result.sha256, sha256(readFileSync(archive)));
    // The archive must not contain plaintext of the covered secrets.
    const raw = readFileSync(archive);
    for (const secret of ['signing-secret-value', 'model-store-key-material', '教师', 'synthetic.sqlite']) {
      assert.ok(!raw.includes(Buffer.from(secret)), `archive leaks ${secret}`);
    }

    const isolated = join(root, 'isolated-restore');
    const restored = await restoreEncryptedBackup({
      restore: archive, keyFile: join(root, 'backup.key'), target: isolated, teachingRoot: TEACHING_ROOT,
    });
    assert.equal(restored.status, 'restored');
    assert.deepEqual(restored.databasesVerified.sort(), ['course/synthetic.sqlite', 'personal-models/personal-agent.sqlite']);
    assert.equal(readFileSync(join(isolated, 'extra/signing-secret.txt'), 'utf8'), 'signing-secret-value');
    assert.equal(readFileSync(join(isolated, 'personal-models/credentials.key'), 'utf8'), 'model-store-key-material');
    // Restored business data keeps its rows and foreign keys hold.
    const Driver = createRequire(join(TEACHING_ROOT, 'package.json'))('better-sqlite3');
    const db = new Driver(join(isolated, 'course/synthetic.sqlite'), { readonly: true, fileMustExist: true });
    try {
      assert.deepEqual(db.prepare('SELECT display_name FROM members').all(), [{ display_name: '教师' }]);
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
      assert.equal(db.pragma('foreign_key_check').length, 0);
    } finally { db.close(); }
    assert.ok(!existsSync(join(isolated, 'personal-models/credentials.key.garbage')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('restore refuses wrong keys and tampered archives without populating the target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xunjie-backup-tamper-'));
  try {
    writeFileSync(join(root, 'backup.key'), 'fixture-maintainer-key-material');
    writeFileSync(join(root, 'wrong.key'), 'a-different-maintainer-key');
    writeBackupConfig(root);
    const result = await createEncryptedBackup(backupOptions(root));
    const archive = result.path;

    const wrongKey = join(root, 'restore-wrong-key');
    await assert.rejects(restoreEncryptedBackup({ restore: archive, keyFile: join(root, 'wrong.key'),
      target: wrongKey, teachingRoot: TEACHING_ROOT }), /authenticate|BACKUP_FAILED|ISOLATED/);
    assert.ok(!existsSync(wrongKey));

    const tampered = Buffer.from(readFileSync(archive));
    tampered[Math.floor(tampered.length / 2)] ^= 0xff;
    const tamperedPath = join(root, 'tampered.xunjiebak');
    writeFileSync(tamperedPath, tampered);
    const tamperedTarget = join(root, 'restore-tampered');
    await assert.rejects(restoreEncryptedBackup({ restore: tamperedPath, keyFile: join(root, 'backup.key'),
      target: tamperedTarget, teachingRoot: TEACHING_ROOT }), /authenticate|BACKUP_FAILED|ISOLATED/);
    assert.ok(!existsSync(tamperedTarget));

    await assert.rejects(restoreEncryptedBackup({ restore: archive, keyFile: join(root, 'backup.key'),
      target: root, teachingRoot: TEACHING_ROOT }), /TARGET_MUST_BE_ISOLATED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('live WAL database is backed up without source sidecars and restores committed writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xunjie-backup-wal-'));
  let source;
  let directory;
  try {
    writeFileSync(join(root, 'backup.key'), 'fixture-maintainer-key-material');
    const fixture = writeBackupConfig(root);
    directory = fixture.directory;
    const Driver = createRequire(join(TEACHING_ROOT, 'package.json'))('better-sqlite3');
    const database = join(fixture.settings.personalModelsDirectory, 'personal-agent.sqlite');
    source = new Driver(database);
    source.pragma('journal_mode = WAL');
    source.pragma('wal_autocheckpoint = 0');
    source.prepare('INSERT INTO submissions VALUES (?, ?, ?)').run('in-wal', 'teacher', 'committed in WAL');
    assert.ok(statSync(database + '-wal').size > 0);
    const backup = await createEncryptedBackup(backupOptions(root));
    assert.ok(backup.files.every(file => !/-wal$|-shm$|-journal$/.test(file)));
    const target = join(root, 'restored');
    const result = await restoreEncryptedBackup({ restore: backup.path, keyFile: join(root, 'backup.key'), target, teachingRoot: TEACHING_ROOT });
    assert.equal(result.databasesVerified.length, 2);
    const restored = new Driver(join(target, 'personal-models/personal-agent.sqlite'), { readonly: true });
    try { assert.equal(restored.prepare('SELECT content FROM submissions WHERE id = ?').pluck().get('in-wal'), 'committed in WAL'); }
    finally { restored.close(); }
  } finally {
    source?.close();
    rmSync(root, { recursive: true, force: true });
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

test('retention keeps only the newest archives of each label', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xunjie-backup-keep-'));
  try {
    writeFileSync(join(root, 'backup.key'), 'fixture-maintainer-key-material');
    writeBackupConfig(root);
    const options = backupOptions(root, { label: 'weekly', keep: 2 });
    const created = [];
    for (let index = 0; index < 3; index += 1) {
      const result = await createEncryptedBackup(options);
      created.push(result.path);
    }
    const remaining = readdirSync(join(root, 'encrypted-backups')).filter(name => name.startsWith('weekly-'));
    assert.equal(remaining.length, 2);
    assert.ok(!existsSync(created[0]));
    assert.ok(existsSync(created[2]));
    // Other labels are never touched by this retention pass.
    const daily = await createEncryptedBackup(backupOptions(root, { label: 'daily', keep: 1 }));
    const all = readdirSync(join(root, 'encrypted-backups'));
    assert.equal(all.filter(name => name.startsWith('daily-')).length, 1);
    assert.equal(all.filter(name => name.startsWith('weekly-')).length, 2);
    assert.ok(existsSync(daily.path));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the CLI runs a full backup and restore round trip', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xunjie-backup-cli-'));
  try {
    writeFileSync(join(root, 'backup.key'), 'fixture-maintainer-key-material');
    writeBackupConfig(root, { personalModels: false });
    const script = join(REPOSITORY, 'tools/i0-cloud/backup-retained.mjs');
    const backup = spawnSync(process.execPath, [script, '--config', join(root, 'backup-config.json'),
      '--key-file', join(root, 'backup.key'), '--label', 'daily', '--keep', '3'], { encoding: 'utf8' });
    assert.equal(backup.status, 0, backup.stderr);
    const summary = JSON.parse(backup.stdout);
    assert.equal(summary.status, 'created');
    assert.deepEqual(summary.files, ['course/synthetic.sqlite']);

    const target = join(root, 'cli-restore');
    const restore = spawnSync(process.execPath, [script, '--restore', summary.path,
      '--key-file', join(root, 'backup.key'), '--target', target, '--teaching-root', TEACHING_ROOT], { encoding: 'utf8' });
    assert.equal(restore.status, 0, restore.stderr);
    const restored = JSON.parse(restore.stdout);
    assert.equal(restored.status, 'restored');
    assert.deepEqual(restored.databasesVerified, ['course/synthetic.sqlite']);

    const bad = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /Usage:/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
