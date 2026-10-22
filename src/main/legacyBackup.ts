import { createDecipheriv, scryptSync } from 'node:crypto'
import type { LegacyClient } from '../shared/legacy'

// Reads the .echobackup files exported by the previous Echo app (Settings → Export
// there). Layout, from its storage.ts: magic "ECHOBACKUP2\n" | scrypt salt(32) |
// iv(12) | GCM tag(16) | ciphertext of { version: 2, exportedAt, clients }.

export const LEGACY_MAGIC = Buffer.from('ECHOBACKUP2\n')

export function isLegacyBackup(blob: Buffer): boolean {
  return blob.subarray(0, LEGACY_MAGIC.length).equals(LEGACY_MAGIC)
}

export function readLegacyBackup(blob: Buffer, password: string): LegacyClient[] {
  if (blob.length <= LEGACY_MAGIC.length + 32 + 28 || !isLegacyBackup(blob)) {
    throw new Error('This isn’t a backup from the previous Echo. Export one there from Settings, then choose that file.')
  }
  const salt = blob.subarray(LEGACY_MAGIC.length, LEGACY_MAGIC.length + 32)
  const body = blob.subarray(LEGACY_MAGIC.length + 32)
  let payload: { version?: number; clients?: LegacyClient[] }
  try {
    const key = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 })
    const decipher = createDecipheriv('aes-256-gcm', key, body.subarray(0, 12))
    decipher.setAuthTag(body.subarray(12, 28))
    payload = JSON.parse(Buffer.concat([decipher.update(body.subarray(28)), decipher.final()]).toString('utf8'))
  } catch {
    throw new Error('Wrong password, or the backup file is damaged.')
  }
  if (payload.version !== 2 || !Array.isArray(payload.clients)) throw new Error('Unsupported backup from the previous Echo.')
  return payload.clients
}
