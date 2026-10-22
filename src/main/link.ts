import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { hostname } from 'node:os'
import type { MobileMemo } from '../shared/types'

// The iPhone link. The phone records and transcribes on-device, then hands the
// text to this Mac over the local network. Nothing goes through a cloud service.
//
// Pairing: Settings shows a QR code holding
//   echo://pair?v=1&id=<pairing id>&key=<base64url 32-byte key>&name=<Mac name>
// The phone keeps the key in its Keychain; this Mac keeps it in the vault.
//
// Discovery: while paired, Echo listens on a random TCP port and advertises it
// over Bonjour as _echo-memo._tcp with TXT pid=<pairing id>, so the phone only
// talks to the Mac it was paired with.
//
// Wire format: one request and one reply per connection, each a frame of a
// 4-byte big-endian length followed by an AES-256-GCM sealed box laid out as
// CryptoKit's `combined` (12-byte nonce, ciphertext, 16-byte tag). The AAD is
// "echo-memo/1 request <id>" or "echo-memo/1 reply <id>", so a reply can't be
// passed off as a request or the other way round.
//   request: {"device":"Jo’s iPhone","memos":[{"id","recordedAt","durationSec","transcript"}]}
//   reply:   {"received":["<memo id>", …],"mac":"<Mac name>"}
// The phone deletes a transcript only once its id comes back in a sealed reply,
// which is sent after the memo is written to disk. A request that doesn't open
// with the key gets an empty frame, which tells the phone to pair again.

export const SERVICE_TYPE = '_echo-memo._tcp'
const MAX_FRAME = 8 * 1024 * 1024
const MAX_TRANSCRIPT = 400_000

export interface LinkPairing {
  id: string
  /** base64 */
  key: string
  pairedAt: string | null
  deviceName: string | null
  lastSeenAt: string | null
}

export function newPairing(): LinkPairing {
  return { id: randomUUID(), key: randomBytes(32).toString('base64'), pairedAt: null, deviceName: null, lastSeenAt: null }
}

let computerName: string | null = null

/** The Mac's name as shown in Sharing settings, e.g. "Jo’s MacBook Air". */
export function macName(): string {
  if (computerName) return computerName
  try {
    computerName = execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim() || hostname()
  } catch {
    computerName = hostname()
  }
  return computerName
}

export function pairingUrl(pairing: LinkPairing, name: string): string {
  const key = Buffer.from(pairing.key, 'base64').toString('base64url')
  return `echo://pair?v=1&id=${pairing.id}&key=${key}&name=${encodeURIComponent(name)}`
}

const aad = (direction: 'request' | 'reply', id: string) => Buffer.from(`echo-memo/1 ${direction} ${id}`, 'utf8')

export function seal(key: Buffer, plaintext: Buffer, ad: Buffer): Buffer {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(ad)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()])
}

/** Null if the box wasn't sealed with this key and AAD. */
export function open(key: Buffer, box: Buffer, ad: Buffer): Buffer | null {
  if (box.length < 28) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, box.subarray(0, 12))
    decipher.setAAD(ad)
    decipher.setAuthTag(box.subarray(box.length - 16))
    return Buffer.concat([decipher.update(box.subarray(12, box.length - 16)), decipher.final()])
  } catch {
    return null
  }
}

export function frame(payload: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(payload.length)
  return Buffer.concat([head, payload])
}

export interface LinkRequest {
  device: string
  memos: Omit<MobileMemo, 'receivedAt'>[]
}

/** Checks a decrypted request's shape. Memos that don't fit are left out (and not acknowledged). */
export function parseRequest(json: string): LinkRequest | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { device?: unknown; memos?: unknown }
  const memos = Array.isArray(r.memos) ? r.memos : []
  return {
    device: typeof r.device === 'string' ? r.device.slice(0, 80) : 'iPhone',
    memos: memos.flatMap((m) => {
      const { id, recordedAt, durationSec, transcript } = (m ?? {}) as Record<string, unknown>
      if (typeof id !== 'string' || !/^[\w-]{8,64}$/.test(id)) return []
      if (typeof recordedAt !== 'string' || Number.isNaN(Date.parse(recordedAt))) return []
      if (typeof transcript !== 'string' || transcript.length > MAX_TRANSCRIPT) return []
      return [{ id, recordedAt: new Date(recordedAt).toISOString(), durationSec: typeof durationSec === 'number' && durationSec >= 0 ? Math.round(durationSec) : 0, transcript }]
    })
  }
}

export interface LinkHandlers {
  pairing(): LinkPairing | null
  /** Store the memos durably and return the ids that are now safe for the phone to delete. */
  receive(request: LinkRequest): string[]
  error(message: string): void
}

/** Reads one frame, answers it, and closes. */
function serve(socket: Socket, handlers: LinkHandlers): void {
  let buf = Buffer.alloc(0)
  socket.setTimeout(20_000, () => socket.destroy())
  socket.on('error', () => socket.destroy())
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    if (buf.length < 4) return
    const length = buf.readUInt32BE(0)
    if (length > MAX_FRAME) return socket.destroy()
    if (buf.length < 4 + length) return
    socket.removeAllListeners('data')
    const pairing = handlers.pairing()
    if (!pairing) return socket.destroy()
    const key = Buffer.from(pairing.key, 'base64')
    const plain = open(key, buf.subarray(4, 4 + length), aad('request', pairing.id))
    const request = plain && parseRequest(plain.toString('utf8'))
    if (!request) return void socket.end(frame(Buffer.alloc(0)))
    let received: string[]
    try {
      received = handlers.receive(request)
    } catch (err) {
      handlers.error((err as Error).message)
      return socket.destroy()
    }
    const reply = Buffer.from(JSON.stringify({ received, mac: macName() }), 'utf8')
    socket.end(frame(seal(key, reply, aad('reply', pairing.id))))
  })
}

/**
 * Listens for the paired phone and advertises over Bonjour with the built-in
 * dns-sd tool, which keeps the service registered for as long as it runs.
 */
export class LinkServer {
  private server: Server | null = null
  private advert: ChildProcess | null = null
  private advertisedId: string | null = null
  private restartTimer: NodeJS.Timeout | null = null

  constructor(private handlers: LinkHandlers) {}

  /** The port being listened on, once listening. */
  get port(): number | null {
    const address = this.server?.address()
    return address && typeof address === 'object' ? address.port : null
  }

  /** Start, restart or stop to match the current pairing. */
  sync(): void {
    const pairing = this.handlers.pairing()
    if (!pairing) return this.stop()
    if (this.server && this.advertisedId === pairing.id) return
    this.stop()
    const server = createServer((socket) => serve(socket, this.handlers))
    server.on('error', (err) => this.handlers.error(`Echo couldn’t listen for your iPhone: ${err.message}`))
    server.listen(0, () => {
      const address = server.address()
      if (address && typeof address === 'object') this.advertise(pairing.id, address.port)
    })
    this.server = server
    this.advertisedId = pairing.id
  }

  private advertise(id: string, port: number): void {
    // dns-sd would outlive Echo if Echo crashed or was force-quit, leaving a stale advert that
    // could shadow the real one. A small shell wrapper stops it as soon as its stdin closes,
    // which happens however Echo ends.
    // (Background jobs get /dev/null as stdin, hence the copy on fd 3.)
    const script = 'exec 3<&0; /usr/bin/dns-sd -R "$@" </dev/null & child=$!; (read _ <&3; kill $child 2>/dev/null) & wait $child'
    const child = spawn('/bin/sh', ['-c', script, 'sh', 'Echo', SERVICE_TYPE, 'local', String(port), `pid=${id}`], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', (err) => this.handlers.error(`Echo couldn’t announce itself to your iPhone: ${err.message}`))
    // dns-sd only exits if something went wrong; announce again shortly while still paired.
    child.on('exit', () => {
      if (this.advert !== child) return
      this.advert = null
      this.restartTimer = setTimeout(() => this.server && this.advertisedId === id && this.advertise(id, port), 5000)
    })
    this.advert = child
  }

  stop(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const advert = this.advert
    this.advert = null
    // Closing stdin makes the wrapper stop dns-sd and exit.
    advert?.stdin?.end()
    this.server?.close()
    this.server = null
    this.advertisedId = null
  }
}
