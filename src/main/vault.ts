import { app, safeStorage } from 'electron'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CLIENT_SETTING, noteSortKey } from '../shared/compliance'
import { backfillDiagnoses } from '../shared/diagnosis'
import { TRANSCRIBE_MODELS, type Client, type MobileMemo, type Note, type Settings } from '../shared/types'
import { isLegacyBackup } from './legacyBackup'
import type { LinkPairing } from './link'
import type { Letterhead } from '../shared/letter'

// All client data lives in one AES-256-GCM encrypted file. The data key is
// random and itself encrypted with the macOS Keychain via Electron safeStorage,
// so the vault file is useless off this Mac user account.

export interface VaultData {
  version: 1
  settings: Settings
  apiKey: string
  clients: Client[]
  notes: Note[]
  /** Recordings from the iPhone waiting for a client. */
  inbox: MobileMemo[]
  /** The paired iPhone's link, or null if none is set up. */
  link: LinkPairing | null
  /** Recordings already taken in, newest last, so one the phone sends twice isn't added twice. */
  receivedMemoIds: string[]
  /** Set once clients without a diagnosis have taken one from their finalized intake, so a diagnosis cleared later stays cleared. */
  diagnosesBackfilled?: boolean
  /** Logo, signatures and practice details for letters. Missing until first edited. */
  letterhead?: Letterhead
}

export const DEFAULT_SETTINGS: Settings = {
  clinicianName: '',
  credentials: '',
  noteFormat: 'SOAP',
  sessionMinutes: 55,
  telehealthPlatform: '',
  planReviewDays: 90,
  includeHeader: true,
  includeSignature: false,
  headingStyle: 'caps',
  customInstructions: '',
  textModel: 'claude-haiku-5-5',
  transcribeModel: 'parakeet-tdt-0.6b-v2',
  reasoningEffort: 'medium',
  liveCoverage: false,
  lockEnabled: false,
  lockMinutes: 10,
  onboarded: false
}

// Echo used to run on OpenAI. Settings that still name an OpenAI model move to
// Claude and the local transcriber; Claude model choices are left alone.
export function migrateSettings(s: Settings): Settings {
  const next = { ...s }
  if (!next.textModel.startsWith('claude-')) next.textModel = DEFAULT_SETTINGS.textModel
  if (!TRANSCRIBE_MODELS.some((m) => m.id === next.transcribeModel)) next.transcribeModel = DEFAULT_SETTINGS.transcribeModel
  // 'minimal' was an OpenAI-only effort level.
  if ((next.reasoningEffort as string) === 'minimal') next.reasoningEffort = 'low'
  delete (next as Partial<Settings> & { liveTranscribeModel?: string }).liveTranscribeModel
  return next
}

/** A saved OpenAI key would only fail with a confusing 401, so it's dropped and Settings asks for an Anthropic key. */
export function migrateApiKey(key: string | undefined): string {
  return key?.startsWith('sk-ant-') ? key : ''
}

// Setting used to be chosen per note. Clients from then take the setting of
// their most recent note, or telehealth if they have none.
function migrateClient(c: Client, notes: Note[]): Client {
  if (c.setting) return c
  const latest = notes.filter((n) => n.clientId === c.id).sort((a, b) => noteSortKey(b).localeCompare(noteSortKey(a)))[0]
  return { ...c, setting: latest?.session.setting ?? DEFAULT_CLIENT_SETTING }
}

const MAGIC = Buffer.from('ECHO1')
const BACKUP_MAGIC = Buffer.from('ECHOBK1')
const BACKUPS_KEPT = 14

function encrypt(key: Buffer, plaintext: Buffer, magic: Buffer, extra = Buffer.alloc(0)): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([magic, extra, iv, cipher.getAuthTag(), body])
}

function decrypt(key: Buffer, blob: Buffer, offset: number): Buffer {
  const iv = blob.subarray(offset, offset + 12)
  const tag = blob.subarray(offset + 12, offset + 28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(blob.subarray(offset + 28)), decipher.final()])
}

export class Vault {
  data: VaultData
  private key: Buffer
  private dir: string
  private saveTimer: NodeJS.Timeout | null = null

  constructor() {
    this.dir = app.getPath('userData')
    mkdirSync(this.dir, { recursive: true })
    this.key = this.loadKey()
    this.data = this.load()
    this.dailyBackup()
  }

  private get vaultPath(): string {
    return join(this.dir, 'echo.vault')
  }

  private loadKey(): Buffer {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('macOS Keychain encryption is unavailable.')
    const keyPath = join(this.dir, 'echo.key')
    if (existsSync(keyPath)) {
      return Buffer.from(safeStorage.decryptString(readFileSync(keyPath)), 'base64')
    }
    if (existsSync(this.vaultPath)) {
      throw new Error(
        `The Keychain key for your Echo data is missing, so ${this.vaultPath} can't be opened. To start fresh, move that file elsewhere and reopen Echo; then restore an exported backup from Settings if you have one.`
      )
    }
    const key = randomBytes(32)
    writeFileSync(keyPath, safeStorage.encryptString(key.toString('base64')), { mode: 0o600 })
    return key
  }

  private load(): VaultData {
    if (!existsSync(this.vaultPath)) {
      return { version: 1, settings: { ...DEFAULT_SETTINGS }, apiKey: '', clients: [], notes: [], inbox: [], link: null, receivedMemoIds: [], diagnosesBackfilled: true }
    }
    const blob = readFileSync(this.vaultPath)
    if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Unrecognized vault file.')
    return this.normalize(JSON.parse(decrypt(this.key, blob, MAGIC.length).toString('utf8')))
  }

  private normalize(raw: VaultData): VaultData {
    const notes = raw.notes ?? []
    return {
      version: 1,
      settings: migrateSettings({ ...DEFAULT_SETTINGS, ...raw.settings }),
      apiKey: migrateApiKey(raw.apiKey),
      clients: (raw.clients ?? []).map((c) => migrateClient(c, notes)).map((c) => (raw.diagnosesBackfilled ? c : backfillDiagnoses(c, notes))),
      notes,
      inbox: raw.inbox ?? [],
      link: raw.link ?? null,
      receivedMemoIds: raw.receivedMemoIds ?? [],
      diagnosesBackfilled: true,
      letterhead: raw.letterhead
    }
  }

  /** Debounced, atomic write. */
  save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flush(), 250)
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    const blob = encrypt(this.key, Buffer.from(JSON.stringify(this.data), 'utf8'), MAGIC)
    const tmp = `${this.vaultPath}.tmp`
    writeFileSync(tmp, blob, { mode: 0o600 })
    renameSync(tmp, this.vaultPath)
  }

  private dailyBackup(): void {
    if (!existsSync(this.vaultPath)) return
    const dir = join(this.dir, 'backups')
    mkdirSync(dir, { recursive: true })
    const today = new Date().toISOString().slice(0, 10)
    const target = join(dir, `echo-${today}.vault`)
    if (!existsSync(target)) copyFileSync(this.vaultPath, target)
    const old = readdirSync(dir).filter((f) => f.endsWith('.vault')).sort().reverse().slice(BACKUPS_KEPT)
    for (const f of old) unlinkSync(join(dir, f))
  }

  /** Portable backup encrypted with a passphrase (scrypt), restorable on any Mac. */
  exportBackup(passphrase: string): Buffer {
    const salt = randomBytes(16)
    const key = scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
    return encrypt(key, Buffer.from(JSON.stringify(this.data), 'utf8'), BACKUP_MAGIC, salt)
  }

  importBackup(blob: Buffer, passphrase: string): void {
    if (isLegacyBackup(blob)) throw new Error('This backup is from the previous Echo. Use File → Import from Previous Echo instead.')
    if (!blob.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) throw new Error('This is not an Echo backup file.')
    const salt = blob.subarray(BACKUP_MAGIC.length, BACKUP_MAGIC.length + 16)
    const key = scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
    let plain: Buffer
    try {
      plain = decrypt(key, blob, BACKUP_MAGIC.length + 16)
    } catch {
      throw new Error('Wrong passphrase, or the backup file is damaged.')
    }
    this.data = this.normalize(JSON.parse(plain.toString('utf8')))
    this.flush()
  }
}
