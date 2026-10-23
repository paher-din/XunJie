#!/usr/bin/env node
// Encrypted backup of the retained business data and recovery materials, plus an
// isolated restore path. Secrets (signing key, TLS material, personal model keys)
// only ever leave the host inside an AES-256-GCM archive; the key file stays with
// the maintainer and is never read into logs or output.

import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, copyFileSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const MAGIC = Buffer.from('XJB1');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ARCHIVE_SUFFIX = '.xunjiebak';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sha256File = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const utcStamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

class BackupError extends Error {}

function require(condition, code) {
  if (!condition) throw new BackupError(code);
}

function parseArguments(argv) {
  const values = { '--config': '', '--key-file': '', '--label': 'daily', '--keep': '7',
    '--restore': '', '--target': '', '--teaching-root': '' };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (!Object.hasOwn(values, name) || !value || seen.has(name)) throw new BackupError('ARGUMENTS_REQUIRED');
    seen.add(name);
    values[name] = value;
  }
  const mode = values['--restore'] ? 'restore' : 'backup';
  if (mode === 'backup') require(values['--config'] && values['--key-file'], 'ARGUMENTS_REQUIRED');
  else require(values['--restore'] && values['--key-file'] && values['--target'] && values['--teaching-root'], 'ARGUMENTS_REQUIRED');
  const keep = Number(values['--keep']);
  require(Number.isInteger(keep) && keep >= 1, 'KEEP_REQUIRED');
  require(['daily', 'weekly'].includes(values['--label']) || /^[a-z][a-z0-9-]{0,15}$/.test(values['--label']), 'LABEL_REQUIRED');
  return { mode, config: resolve(values['--config']), keyFile: resolve(values['--key-file']),
    label: values['--label'], keep, restore: resolve(values['--restore']),
    target: resolve(values['--target']), teachingRoot: resolve(values['--teaching-root']) };
}

function readJson(path) {
  const file = lstatSync(path);
  require(file.isFile() && !file.isSymbolicLink(), 'CONTROLLED_JSON_REQUIRED');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadDriver(teachingRoot) {
  require(existsSync(join(teachingRoot, 'package.json')), 'TEACHING_ROOT_REQUIRED');
  return createRequire(join(teachingRoot, 'package.json'))('better-sqlite3');
}

// Consistent copy through SQLite's backup API; the source must pass integrity and FK checks first.
async function consistentDatabaseCopy(Driver, source, destination) {
  const db = new Driver(source, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length) {
      throw new BackupError('SOURCE_DATABASE_INTEGRITY_FAILED');
    }
    const descriptor = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    closeSync(descriptor);
    await db.backup(destination);
  } finally {
    db.close();
  }
}

function walkFiles(root) {
  const files = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && !entry.isSymbolicLink()) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

export async function createEncryptedBackup(options) {
  const { config, keyFile, label, keep } = options;
  const settings = readJson(config);
  const expected = { courseDatabaseFile: '', personalModelsDirectory: '', extraFiles: [], outputDirectory: '', teachingRoot: '' };
  for (const key of Object.keys(expected)) require(Object.hasOwn(settings, key), 'BACKUP_CONFIG_REQUIRED');
  require(typeof settings.courseDatabaseFile === 'string' && isAbsolute(settings.courseDatabaseFile), 'BACKUP_CONFIG_REQUIRED');
  require(typeof settings.outputDirectory === 'string' && isAbsolute(settings.outputDirectory), 'BACKUP_CONFIG_REQUIRED');
  require(typeof settings.teachingRoot === 'string' && isAbsolute(settings.teachingRoot), 'BACKUP_CONFIG_REQUIRED');
  require(Array.isArray(settings.extraFiles) && settings.extraFiles.every(file => typeof file === 'string' && isAbsolute(file)), 'BACKUP_CONFIG_REQUIRED');
  require(settings.personalModelsDirectory === '' || (typeof settings.personalModelsDirectory === 'string' && isAbsolute(settings.personalModelsDirectory)), 'BACKUP_CONFIG_REQUIRED');
  const Driver = loadDriver(settings.teachingRoot);

  const staging = mkdtempSync(join(tmpdir(), 'xunjie-backup-'));
  const contents = [];
  try {
    mkdirSync(join(staging, 'course'), { recursive: true });
    const courseCopy = join(staging, 'course', 'synthetic.sqlite');
    await consistentDatabaseCopy(Driver, settings.courseDatabaseFile, courseCopy);
    contents.push({ path: 'course/synthetic.sqlite', sha256: sha256File(courseCopy), source: settings.courseDatabaseFile });

    if (settings.personalModelsDirectory) {
      const root = settings.personalModelsDirectory;
      require(existsSync(root) && lstatSync(root).isDirectory(), 'PERSONAL_MODELS_DIRECTORY_REQUIRED');
      for (const file of walkFiles(root)) {
        // SQLite Backup API already incorporates committed WAL pages. Copying
        // the live source journal onto that snapshot can replay another epoch.
        if (/\.(?:sqlite|sqlite3|db)-(?:wal|shm|journal)$/.test(file)) continue;
        const relativePath = relative(root, file).split('\\').join('/');
        const target = join(staging, 'personal-models', relativePath);
        mkdirSync(dirname(target), { recursive: true });
        if (file.endsWith('.sqlite')) await consistentDatabaseCopy(Driver, file, target);
        else copyFileSync(file, target);
        contents.push({ path: 'personal-models/' + relativePath, sha256: sha256File(target), source: file });
      }
    }
    const names = new Set();
    mkdirSync(join(staging, 'extra'), { recursive: true });
    for (const file of settings.extraFiles) {
      const name = file.split('/').pop();
      require(!names.has(name), 'EXTRA_FILE_NAME_COLLISION');
      names.add(name);
      copyFileSync(file, join(staging, 'extra', name));
      contents.push({ path: 'extra/' + name, sha256: sha256File(join(staging, 'extra', name)), source: file });
    }
    const manifest = { format: 'xunjie-encrypted-backup', version: 1, label, createdAt: new Date().toISOString(), files: contents };
    writeFileSync(join(staging, 'backup-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    const plain = join(staging, 'archive.tar.gz');
    if (spawnSync('tar', ['-czf', plain, '-C', staging, 'course', ...(settings.personalModelsDirectory ? ['personal-models'] : []), 'extra', 'backup-manifest.json'],
      { stdio: ['ignore', 'ignore', 'pipe'] }).status !== 0) throw new BackupError('TARBALL_FAILED');

    mkdirSync(settings.outputDirectory, { recursive: true, mode: 0o700 });
    const archive = join(settings.outputDirectory,
      `${label}-${utcStamp(new Date())}-${createHash('sha256').update(String(process.hrtime.bigint())).digest('hex').slice(0, 8)}${ARCHIVE_SUFFIX}`);
    await encryptFile(plain, archive, keyFile);
    const pruned = pruneBackups(settings.outputDirectory, label, keep);
    return { status: 'created', path: archive, bytes: statSync(archive).size, sha256: sha256File(archive),
      files: contents.map(entry => entry.path), pruned };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function encryptFile(plain, archive, keyFile) {
  const key = createHash('sha256').update(readFileSync(keyFile)).digest();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const descriptor = openSync(archive, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  closeSync(descriptor);
  try {
    await pipeline(createReadStream(plain), cipher, createWriteStream(archive, { flags: 'r+' }));
  } catch (error) {
    rmSync(archive, { force: true });
    throw error;
  }
  const tag = cipher.getAuthTag();
  const output = openSync(archive, constants.O_WRONLY | constants.O_APPEND);
  try { writeFileSync(output, Buffer.concat([MAGIC, iv, tag])); } finally { closeSync(output); }
}

export async function restoreEncryptedBackup(options) {
  const { restore, keyFile, target, teachingRoot } = options;
  require(lstatSync(restore).isFile(), 'ARCHIVE_REQUIRED');
  require(isAbsolute(target) && target !== '/' && !target.includes('..'), 'TARGET_MUST_BE_ISOLATED');
  require(!existsSync(target) || (lstatSync(target).isDirectory() && readdirSync(target).length === 0), 'TARGET_MUST_BE_ISOLATED');
  const size = statSync(restore).size;
  require(size > MAGIC.length + IV_BYTES + TAG_BYTES, 'ARCHIVE_CORRUPT');
  const header = Buffer.alloc(MAGIC.length + IV_BYTES + TAG_BYTES);
  const descriptor = openSync(restore, constants.O_RDONLY);
  try {
    readFully(descriptor, header, 0, header.length, size - header.length);
    require(header.subarray(0, MAGIC.length).equals(MAGIC), 'ARCHIVE_CORRUPT');
    const iv = header.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
    const tag = header.subarray(MAGIC.length + IV_BYTES);
    const key = createHash('sha256').update(readFileSync(keyFile)).digest();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const staging = mkdtempSync(join(tmpdir(), 'xunjie-restore-'));
    try {
      const plain = join(staging, 'archive.tar.gz');
      await pipeline(
        createReadStream(restore, { start: 0, end: size - header.length - 1 }),
        decipher,
        createWriteStream(plain));
      const listing = spawnSync('tar', ['-tzf', plain], { encoding: 'utf8' });
      require(listing.status === 0, 'ARCHIVE_CORRUPT');
      const names = listing.stdout.trim().split('\n').filter(Boolean);
      require(names.every(name => !name.startsWith('/') && !name.split('/').includes('..')), 'ARCHIVE_UNSAFE_PATHS');
      const extracted = join(staging, 'extracted');
      mkdirSync(extracted);
      require(spawnSync('tar', ['-xzf', plain, '-C', extracted]).status === 0, 'ARCHIVE_CORRUPT');
      const manifest = readJson(join(extracted, 'backup-manifest.json'));
      require(manifest.format === 'xunjie-encrypted-backup' && Array.isArray(manifest.files), 'ARCHIVE_MANIFEST_REQUIRED');
      for (const entry of manifest.files) {
        const path = join(extracted, entry.path);
        require(existsSync(path) && sha256File(path) === entry.sha256, 'ARCHIVE_FILE_DIGEST_MISMATCH');
      }
      mkdirSync(target, { recursive: true });
      if (spawnSync('mv', [join(extracted, 'course'), join(extracted, 'personal-models'), join(extracted, 'extra'),
        join(extracted, 'backup-manifest.json'), target].filter(source => existsSync(source))).status !== 0) {
        throw new BackupError('RESTORE_FAILED');
      }
      const Driver = loadDriver(teachingRoot);
      const verified = [];
      const personalModels = join(target, 'personal-models');
      const candidates = ['course/synthetic.sqlite',
        ...(existsSync(personalModels)
          ? walkFiles(personalModels).filter(file => file.endsWith('.sqlite')).map(file => relative(target, file))
          : [])];
      for (const file of candidates) {
        const database = join(target, file);
        if (!existsSync(database)) continue;
        const db = new Driver(database, { readonly: true, fileMustExist: true });
        try {
          require(db.pragma('integrity_check', { simple: true }) === 'ok' && db.pragma('foreign_key_check').length === 0,
            'RESTORE_INTEGRITY_FAILED');
          verified.push(file);
        } finally { db.close(); }
      }
      return { status: 'restored', target, files: manifest.files.map(entry => entry.path), databasesVerified: verified,
        label: manifest.label, createdAt: manifest.createdAt };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  } finally {
    closeSync(descriptor);
  }
}

function readFully(descriptor, buffer, offset, length, position) {
  let read = 0;
  while (read < length) {
    const bytes = readSync(descriptor, buffer, offset + read, length - read, position + read);
    if (bytes === 0) throw new BackupError('ARCHIVE_CORRUPT');
    read += bytes;
  }
}

function pruneBackups(outputDirectory, label, keep) {
  const pattern = new RegExp(`^${label}-[0-9TZ]+-[0-9a-f]{8}\\${ARCHIVE_SUFFIX}$`);
  const archives = readdirSync(outputDirectory)
    .filter(name => pattern.test(name))
    .map(name => join(outputDirectory, name))
    .filter(path => lstatSync(path).isFile())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs || (a < b ? -1 : 1));
  return archives.slice(keep).map(path => { rmSync(path); return path; });
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write('Usage:\n'
      + '  backup: node tools/i0-cloud/backup-retained.mjs --config <file> --key-file <file> [--label daily|weekly] [--keep N]\n'
      + '  restore: node tools/i0-cloud/backup-retained.mjs --restore <archive> --key-file <file> --target <empty-dir> --teaching-root <dir>\n');
    if (error instanceof BackupError) process.stderr.write(error.message + '\n');
    process.exitCode = 2;
    return;
  }
  (async () => {
    const result = options.mode === 'backup'
      ? await createEncryptedBackup(options)
      : await restoreEncryptedBackup(options);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  })().catch(error => {
    process.stderr.write(JSON.stringify({ status: 'failed', code: error instanceof BackupError ? error.message : 'BACKUP_FAILED' }) + '\n');
    process.exitCode = 1;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
