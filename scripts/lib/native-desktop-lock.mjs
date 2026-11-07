import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** An active physical desktop has exactly one acceptance owner across worktrees. */
export async function acquireNativeDesktop(platform, sessionId, purpose) {
  if (!['macos', 'windows'].includes(platform) || !sessionId) throw new Error('A platform and current session ID are required.');
  const directory = join(homedir(), '.cache/xunjie-native-desktop-locks', platform);
  const owner = { sessionId, createdAt: new Date().toISOString(), purpose, token: randomUUID() };
  try { await mkdir(directory); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let current;
    try { current = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8')); } catch { current = { sessionId: 'unreadable' }; }
    throw new Error('Desktop lock is held; check the live session before waiting: ' + JSON.stringify(current));
  }
  try { await writeFile(join(directory, 'owner.json'), JSON.stringify(owner) + '\n', { flag: 'wx' }); }
  catch (error) { await rm(directory, { recursive: true }); throw error; }
  return async () => {
    const current = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'));
    if (current.token !== owner.token || current.sessionId !== sessionId) throw new Error('Desktop ownership changed; refusing to remove the lock.');
    await rm(directory, { recursive: true });
  };
}
