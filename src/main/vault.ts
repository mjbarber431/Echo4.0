import { app, safeStorage } from 'electron'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DEFAULT_CLIENT_SETTING, noteSortKey } from '../shared/compliance'
import { backfillDiagnoses } from '../shared/diagnosis'
import { TRANSCRIBE_MODELS, type Client, type MobileMemo, type Note, type Settings } from '../shared/types'
import { isLegacyBackup } from './legacyBackup'
import type { LinkPairing } from './link'
import type { Letterhead } from '../shared/letter'
import type { ChatThread } from '../shared/chat'
import type { ClientDocument } from '../shared/documents'

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
  /** Ask Claude conversations, per client. Not part of the record. */
  chats: ChatThread[]
  /** Clients' documents. Their PDFs are separate encrypted files (Vault.writeFile). */
  documents: ClientDocument[]
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
  chatModel: 'claude-opus-5-5',
  transcribeModel: 'parakeet-tdt-0.6b-v2',
  reasoningEffort: 'medium',
  liveCoverage: false,
  lockEnabled: false,
  lockMinutes: 10,
  onboarded: false,
  ehrs: [],
  ehrLayout: 'side',
  ehrOpenOnChart: true
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
const FILE_MAGIC = Buffer.from('ECHOF1')
const FILE_ID = /^[0-9a-f-]{36}$/
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
    this.collectFiles()
  }

  // ---------------------------------------------------------------------------
  // Document files: each PDF in its own file, encrypted with the vault's key, so
  // saving the vault never rewrites them. They're written once and never changed.
  // ---------------------------------------------------------------------------

  private get filesDir(): string {
    return join(this.dir, 'documents')
  }

  private filePath(id: string): string {
    if (!FILE_ID.test(id)) throw new Error('Not a document file.')
    return join(this.filesDir, `${id}.bin`)
  }

  /** Stores a file and returns its ID. */
  writeFile(bytes: Uint8Array): string {
    mkdirSync(this.filesDir, { recursive: true, mode: 0o700 })
    const id = randomUUID()
    const tmp = `${this.filePath(id)}.tmp`
    writeFileSync(tmp, encrypt(this.key, Buffer.from(bytes), FILE_MAGIC), { mode: 0o600 })
    renameSync(tmp, this.filePath(id))
    return id
  }

  readFile(id: string): Buffer {
    const path = this.filePath(id)
    if (!existsSync(path)) throw new Error('This document’s file is missing. Restore a backup to get it back.')
    const blob = readFileSync(path)
    if (!blob.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) throw new Error('Unrecognized document file.')
    return decrypt(this.key, blob, FILE_MAGIC.length)
  }

  /**
   * Removes files no document uses any more, once they're older than the oldest daily snapshot,
   * so restoring a snapshot still finds the files it refers to.
   */
  private collectFiles(): void {
    if (!existsSync(this.filesDir)) return
    const used = new Set(this.data.documents.map((d) => d.file))
    const cutoff = Date.now() - BACKUPS_KEPT * 86_400_000
    for (const name of readdirSync(this.filesDir)) {
      const id = name.replace(/\.bin(\.tmp)?$/, '')
      if (used.has(id)) continue
      const path = join(this.filesDir, name)
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path)
      } catch {
        // Gone already.
      }
    }
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
      return { version: 1, settings: { ...DEFAULT_SETTINGS }, apiKey: '', clients: [], notes: [], inbox: [], link: null, receivedMemoIds: [], diagnosesBackfilled: true, chats: [], documents: [] }
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
      letterhead: raw.letterhead,
      chats: raw.chats ?? [],
      documents: raw.documents ?? []
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
    // Document files travel inside the backup, so it restores everything on its own.
    const files: Record<string, string> = {}
    for (const doc of this.data.documents) {
      if (files[doc.file]) continue
      try {
        files[doc.file] = this.readFile(doc.file).toString('base64')
      } catch {
        // A missing file can't be backed up; the rest still is.
      }
    }
    return encrypt(key, Buffer.from(JSON.stringify({ ...this.data, files }), 'utf8'), BACKUP_MAGIC, salt)
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
    const { files = {}, ...data } = JSON.parse(plain.toString('utf8')) as VaultData & { files?: Record<string, string> }
    const restored = this.normalize(data)
    // Each file is written under a new ID, so nothing already on this Mac is overwritten.
    const ids = new Map<string, string>()
    restored.documents = restored.documents.flatMap((doc) => {
      if (!ids.has(doc.file)) {
        if (!files[doc.file]) return []
        ids.set(doc.file, this.writeFile(Buffer.from(files[doc.file], 'base64')))
      }
      return [{ ...doc, file: ids.get(doc.file)! }]
    })
    this.data = restored
    this.flush()
  }
}
