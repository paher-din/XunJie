import { join, resolve } from 'node:path'

/** A specific override keeps its existing layout; the shared directory groups suites. */
export function evidenceDirectory(suite = '', override?: string): string | undefined {
  if (override?.trim()) return resolve(override)
  const directory = process.env.XUNJIE_EVIDENCE_DIR
  return directory?.trim() ? resolve(directory, suite) : undefined
}

/** Call only after checking evidenceDirectory(), so ordinary tests never create output. */
export function evidencePath(relativePath: string): string {
  const directory = evidenceDirectory()
  if (!directory) throw new Error('Set XUNJIE_EVIDENCE_DIR to save test evidence')
  return join(directory, relativePath)
}
