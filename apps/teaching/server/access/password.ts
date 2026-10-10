import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../app/errors.ts';

export interface PasswordRecord { hash: Buffer; salt: Buffer }
async function hashPassword(password: string, salt: Buffer) {
  return await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 201326592 }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}
export async function createPasswordRecord(password: string): Promise<PasswordRecord> {
  const salt = randomBytes(16);
  return { salt, hash: await hashPassword(password, salt) };
}
export async function createPasswordVerifier() {
  const dummy = await createPasswordRecord(randomBytes(32).toString('hex'));
  let active = 0;
  return async (password: string, record: PasswordRecord | undefined) => {
    if (active >= 2) throw new ApiError('RATE_LIMITED');
    active++;
    try {
      const candidate = record ?? dummy;
      const computed = await hashPassword(password, candidate.salt);
      const equal = computed.length === candidate.hash.length && timingSafeEqual(computed, candidate.hash);
      return record !== undefined && equal;
    } finally { active--; }
  };
}
