import { afterEach, describe, expect, it } from 'vitest'
import { connect } from 'node:net'
import type { Client, Note, Settings } from '../src/shared/types'
import { correctHeardName, matchClients, memoToNote, soundKey } from '../src/shared/mobile'
import { redactName } from '../src/shared/prompts'
import { frame, LinkServer, newPairing, open, pairingUrl, parseRequest, seal, type LinkPairing, type LinkRequest } from '../src/main/link'

const settings = { noteFormat: 'SOAP', sessionMinutes: 55 } as Settings

function client(id: string, name: string, extra: Partial<Client> = {}): Client {
  return {
    id,
    name,
    pronouns: '',
    setting: 'office',
    diagnoses: [],
    status: 'active',
    context: '',
    scratchpad: '',
    plan: null,
    planHistory: [],
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...extra
  }
}

const clients = [client('k', 'Kaitlyn Moore'), client('j', 'Jon Park'), client('s', 'Stephen Alvarez'), client('w', 'Will Turner'), client('m', 'Maryann Lee'), client('k2', 'Katie Moore')]

describe('matching the client named in a recording', () => {
  it('folds common spellings of the same sound together', () => {
    expect(soundKey('Kaitlyn')).toBe(soundKey('Caitlin'))
    expect(soundKey('Jon')).toBe(soundKey('John'))
    expect(soundKey('Steven')).toBe(soundKey('Stephen'))
    expect(soundKey('Sean')).toBe(soundKey('Shawn'))
  })

  it('finds a misspelled first name and preselects it', () => {
    const [top] = matchClients('This is for Caitlin. She came in tired today and talked about work.', clients)
    expect(top.clientId).toBe('k')
    expect(top.likely).toBe(true)
    expect(top.heard).toEqual([{ heard: 'Caitlin', part: 'Kaitlyn' }])
  })

  it('uses the last name to tell apart clients who share a surname or first name', () => {
    const matches = matchClients('Session with John Park, follow-up on sleep.', clients)
    expect(matches[0].clientId).toBe('j')
    expect(matches[0].heard.map((h) => h.part)).toEqual(['Jon', 'Park'])
  })

  it('does not preselect when two clients are equally likely', () => {
    const matches = matchClients('Moore family session today.', clients)
    expect(matches.map((m) => m.clientId).sort()).toEqual(['k', 'k2'])
    expect(matches[0].likely).toBe(false)
  })

  it('matches a name split into two words', () => {
    expect(matchClients('Mary Ann today worked on boundaries.', clients)[0]).toMatchObject({ clientId: 'm', likely: true })
  })

  it('ignores ordinary lowercase words that happen to be names', () => {
    expect(matchClients('Okay so we will talk about the plan.', clients).find((m) => m.clientId === 'w')).toBeUndefined()
  })

  it('finds a name said after the opening', () => {
    const late = `${'and then we talked about it '.repeat(5)}This was Stephen today.`
    expect(matchClients(late, clients)[0]).toMatchObject({ clientId: 's', likely: true })
  })

  it('stops at the first name heard, so people mentioned later are not suggested', () => {
    const matches = matchClients('This is for Caitlin. Later she talked about Stephen and Will at work.', clients)
    expect(matches.map((m) => m.clientId)).toEqual(['k'])
    expect(matches[0].likely).toBe(true)
  })

  it('suggests nobody when no name is heard', () => {
    expect(matchClients('Client reported improved mood this week.', clients)).toEqual([])
  })
})

describe('turning a recording into a note', () => {
  it('respells a misheard name so it is removed before anything is sent to Claude', () => {
    const text = 'This is for Caitlin. Caitlin’s week was hard; CAITLIN said so. Caitlina is her sister.'
    const corrected = correctHeardName(text, [{ heard: 'Caitlin', part: 'Kaitlyn' }])
    const sent = redactName(corrected, 'Kaitlyn Moore')
    expect(sent).not.toMatch(/caitlin(?!a)/i)
    expect(sent).toContain('Client’s week')
    expect(sent).toContain('Caitlina')
  })

  it('joins a name heard as two words', () => {
    expect(correctHeardName('Mary Ann came in.', [{ heard: 'Mary Ann', part: 'Maryann' }])).toBe('Maryann came in.')
  })

  const memo = { id: 'memo-12345678', recordedAt: new Date(2026, 9, 16, 15, 30).toISOString(), durationSec: 240, transcript: ' This is for Caitlin. Talked about work. ', receivedAt: new Date(2026, 9, 19, 9).toISOString() }

  it('dates the session the day it was recorded, not the day it arrived', () => {
    const note = memoToNote(memo, clients[0], [], settings, [{ heard: 'Caitlin', part: 'Kaitlyn' }], '2026-10-19T13:00:00Z')
    expect(note.session.date).toBe('2026-10-16')
    expect(note).toMatchObject({ id: memo.id, clientId: 'k', type: 'intake', source: 'mobile', status: 'draft', dictation: 'This is for Kaitlyn. Talked about work.' })
  })

  it('is a progress note once the client has history, and fills an untouched draft rather than adding another', () => {
    const blank = memoToNote({ ...memo, id: 'draft-1', transcript: '' }, clients[0], [], settings, [], 'x')
    const finalized = { ...blank, id: 'old', status: 'final' } as Note
    const note = memoToNote(memo, clients[0], [finalized, { ...blank, dictation: '' }], settings, [], 'now')
    expect(note.id).toBe('draft-1')
    expect(note.dictation).toBe('This is for Caitlin. Talked about work.')
    const fresh = memoToNote(memo, clients[0], [finalized], settings, [], 'now')
    expect(fresh.type).toBe('progress')
  })
})

describe('the iPhone link', () => {
  const pairing: LinkPairing = newPairing()
  const key = Buffer.from(pairing.key, 'base64')
  const ad = (d: string) => Buffer.from(`echo-memo/1 ${d} ${pairing.id}`)

  it('puts the key and pairing id in the pairing code', () => {
    const url = new URL(pairingUrl(pairing, 'Jo’s Mac'))
    expect(url.protocol).toBe('echo:')
    expect(url.searchParams.get('id')).toBe(pairing.id)
    expect(Buffer.from(url.searchParams.get('key')!, 'base64url').equals(key)).toBe(true)
    expect(url.searchParams.get('name')).toBe('Jo’s Mac')
  })

  it('seals in CryptoKit’s combined layout and refuses the wrong direction or key', () => {
    const box = seal(key, Buffer.from('hello'), ad('request'))
    expect(box.length).toBe(12 + 5 + 16)
    expect(open(key, box, ad('request'))?.toString()).toBe('hello')
    expect(open(key, box, ad('reply'))).toBeNull()
    expect(open(Buffer.alloc(32), box, ad('request'))).toBeNull()
  })

  it('opens a box sealed by CryptoKit', () => {
    // Made with CryptoKit: AES.GCM.seal("hello", using: key 0x01…0x20, nonce 0x00…0x0b, authenticating: "echo-memo/1 request test").combined
    const fixed = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1))
    const box = Buffer.from(CRYPTOKIT_BOX, 'base64')
    expect(open(fixed, box, Buffer.from('echo-memo/1 request test'))?.toString()).toBe('hello')
  })

  it('keeps only well-formed memos', () => {
    const r = parseRequest(JSON.stringify({ device: 'Jo’s iPhone', memos: [{ id: 'bad id!', recordedAt: '2026-10-16T10:00:00Z', transcript: 'x' }, { id: 'memo-12345678', recordedAt: '2026-10-16T10:00:00Z', durationSec: 61.4, transcript: 'hi' }, null] }))
    expect(r).toEqual({ device: 'Jo’s iPhone', memos: [{ id: 'memo-12345678', recordedAt: '2026-10-16T10:00:00.000Z', durationSec: 61, transcript: 'hi' }] })
    expect(parseRequest('not json')).toBeNull()
  })

  let server: LinkServer | null = null
  afterEach(() => server?.stop())

  function exchange(port: number, payload: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => socket.write(frame(payload)))
      let buf = Buffer.alloc(0)
      socket.on('data', (c: Buffer) => (buf = Buffer.concat([buf, c])))
      socket.on('end', () => resolve(buf))
      socket.on('error', reject)
    })
  }

  async function listening(s: LinkServer): Promise<number> {
    for (let i = 0; i < 50 && s.port === null; i++) await new Promise((r) => setTimeout(r, 10))
    return s.port!
  }

  it('acknowledges memos in a sealed reply once they are received', async () => {
    const got: LinkRequest[] = []
    server = new LinkServer({ pairing: () => pairing, receive: (r) => (got.push(r), r.memos.map((m) => m.id)), error: () => {} })
    server.sync()
    const port = await listening(server)
    const request = { device: 'Jo’s iPhone', memos: [{ id: 'memo-12345678', recordedAt: '2026-10-16T10:00:00Z', durationSec: 60, transcript: 'This is for Jon.' }] }
    const reply = await exchange(port, seal(key, Buffer.from(JSON.stringify(request)), ad('request')))
    expect(reply.readUInt32BE(0)).toBe(reply.length - 4)
    const body = JSON.parse(open(key, reply.subarray(4), ad('reply'))!.toString())
    expect(body.received).toEqual(['memo-12345678'])
    expect(got[0].memos[0].transcript).toBe('This is for Jon.')
  })

  it('answers a phone with the wrong key with an empty frame', async () => {
    server = new LinkServer({ pairing: () => pairing, receive: () => [], error: () => {} })
    server.sync()
    const port = await listening(server)
    const reply = await exchange(port, seal(Buffer.alloc(32, 7), Buffer.from('{}'), ad('request')))
    expect(reply.equals(Buffer.from([0, 0, 0, 0]))).toBe(true)
  })
})

const CRYPTOKIT_BOX = 'AAECAwQFBgcICQoLGVVt+6eyEqdT2rU+xCreBu0YDFIN'
