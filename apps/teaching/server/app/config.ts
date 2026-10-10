export function readPort(value: string | undefined): number {
  if (value === undefined) return 3000;
  if (!/^[0-9]+$/.test(value)) throw new Error('PORT must be an integer from 1 to 65535.');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535.');
  }
  return port;
}
