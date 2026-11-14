import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Same AES-256-GCM primitive and explicit owning-account binding as the isolated legacy vault.
// This owner has independent key material and never imports legacy account/configuration state.
export function sealCredential(key: Uint8Array, binding: string, value: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(binding));
  return { iv: iv.toString('base64'), ciphertext: Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64'),
    authenticationTag: cipher.getAuthTag().toString('base64') };
}
export function openCredential(key: Uint8Array, binding: string, sealed: ReturnType<typeof sealCredential>) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAAD(Buffer.from(binding)); decipher.setAuthTag(Buffer.from(sealed.authenticationTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
