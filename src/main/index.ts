import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, protocol, session, shell, systemPreferences } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import QRCode from 'qrcode'
import { autoUpdater } from 'electron-updater'
import { WRITING_MODELS, type AppState, type Client, type DocumentEvent, type MobileLinkStatus, type Note, type PublicSettings, type Settings, type UpdateStatus } from '../shared/types'
import { coachItems, mockCoverage } from '../shared/coach'
import { buildChatSystem, CHAT_MODELS, chatTitle, DEFAULT_CHAT_MODEL, describeDocuments, startCost, summarize, userContent, type ChatEvent, type ChatThread } from '../shared/chat'
import { noteSortKey, todayISO } from '../shared/compliance'
import { partLabel, resourceById, type Resource, type ResourcePart } from '../shared/resources'
import { planToDocumentHtml } from '../shared/format'
import { DEFAULT_LETTERHEAD, letterFooterTemplate, letterToDocumentHtml, signerLabel, type Letter, type Letterhead } from '../shared/letter'
import { assignablePart, assignedParts, exportedPages, exportFileName, startsAsTodo, titleFromFile, type ClientDocument, type DocOrigin, type DocSection, type DocStatus } from '../shared/documents'
import { combinePdfs, imagesToPdf, inspectPdf, renderDocument, selectPages } from '../shared/documentPdf'
import { mergeLegacy, summarizeLegacy, type LegacyClient } from '../shared/legacy'
import { readLegacyBackup } from './legacyBackup'
import { Vault } from './vault'
import { LinkServer, macName, newPairing, pairingUrl, type LinkRequest } from './link'
import * as ai from './ai'
import { openEhrs, showEhr } from './ehr'
import * as local from './local'
import { commitLive, sendLiveAudio, startLive, stopLive } from './live'
import { onTranscriberStatus, prepareTranscriber, stopTranscriber, transcribe, transcriberStatus } from './transcriber'

// Claude requests must go only to the HIPAA-configured organization whose key is
// saved in Settings. Drop any Anthropic settings inherited from the shell (a
// base URL, token, extra headers or debug logging) before anything reads them.
for (const name of Object.keys(process.env)) if (name.startsWith('ANTHROPIC_')) delete process.env[name]

const MOCK = process.env.ECHO_MOCK_AI === '1'
let vault: Vault
let win: BrowserWindow | null = null
/** The previous Echo's backup while the import window is open. Held in memory only, never written out as-is. */
let legacy: LegacyClient[] | null = null
let link: LinkServer
/** The last problem the iPhone link ran into, until it next works. */
let linkError = ''
let update: UpdateStatus = { state: 'idle', version: '', progress: 0 }

function setUpdate(next: UpdateStatus): void {
  update = next
  win?.webContents.send('update', update)
}

function publicSettings(): PublicSettings {
  return { ...vault.data.settings, hasApiKey: !!vault.data.apiKey, mockAI: MOCK }
}

function state(): AppState {
  return { settings: publicSettings(), clients: vault.data.clients, notes: vault.data.notes, inbox: vault.data.inbox, documents: vault.data.documents }
}

function linkStatus(): MobileLinkStatus {
  const pairing = vault.data.link
  if (!pairing) return { state: 'off', deviceName: null, lastSeenAt: null, message: '' }
  const { deviceName, lastSeenAt } = pairing
  if (linkError) return { state: 'error', deviceName, lastSeenAt, message: linkError }
  return { state: pairing.pairedAt ? 'paired' : 'waiting', deviceName, lastSeenAt, message: '' }
}

/** Recordings received from the phone become inbox items. Already-seen ids are acknowledged again but not re-added. */
function receiveMemos(request: LinkRequest): string[] {
  const pairing = vault.data.link
  if (!pairing) return []
  const now = new Date().toISOString()
  const seen = new Set(vault.data.receivedMemoIds)
  const fresh = request.memos.filter((m) => !seen.has(m.id))
  vault.data.inbox.push(...fresh.filter((m) => m.transcript.trim()).map((m) => ({ ...m, receivedAt: now })))
  vault.data.receivedMemoIds = [...vault.data.receivedMemoIds, ...fresh.map((m) => m.id)].slice(-2000)
  vault.data.link = { ...pairing, pairedAt: pairing.pairedAt ?? now, deviceName: request.device, lastSeenAt: now }
  // The phone deletes its copy once this returns, so the memos must be on disk first.
  vault.flush()
  linkError = ''
  if (fresh.length) win?.webContents.send('inbox', vault.data.inbox)
  win?.webContents.send('link', linkStatus())
  return request.memos.map((m) => m.id)
}

function requireKey(): string {
  if (!vault.data.apiKey) throw new Error('Add your Anthropic API key in Settings first.')
  return vault.data.apiKey
}

/** A client's finalized notes, most recent first. */
function finalizedNotes(clientId: string, excludeId?: string): Note[] {
  return vault.data.notes
    .filter((n) => n.clientId === clientId && n.id !== excludeId && n.status === 'final')
    .sort((a, b) => noteSortKey(b).localeCompare(noteSortKey(a)))
}

/** Cropped to the ink and scaled to what a printed page needs, as a PNG data URL. */
function letterheadImage(image: Electron.NativeImage, kind: 'logo' | 'signature'): string {
  const trimmed = trimToInk(image)
  const width = Math.min(trimmed.getSize().width, kind === 'logo' ? 600 : 1000)
  return trimmed.resize({ width, quality: 'best' }).toDataURL()
}

// The practice's logo and signatures ship inside the app (package.json extraResources);
// in development they're read from the project folder. '' if one isn't there.
const BUNDLED_LETTERHEAD: Record<string, string> = { logo: 'Green logo.png', matthew: 'Matthew Signature.png', grace: 'Grace Signature.png' }
const bundled = new Map<string, string>()
function bundledImage(id: string): string {
  if (!BUNDLED_LETTERHEAD[id]) return ''
  if (!bundled.has(id)) {
    const path = app.isPackaged ? join(process.resourcesPath, 'letterhead', `${id}.png`) : join(app.getAppPath(), BUNDLED_LETTERHEAD[id])
    const image = nativeImage.createFromPath(path)
    bundled.set(id, image.isEmpty() ? '' : letterheadImage(image, id === 'logo' ? 'logo' : 'signature'))
  }
  return bundled.get(id)!
}

/** Crops an image to its ink: pixels that are neither transparent nor near-white. */
function trimToInk(image: Electron.NativeImage): Electron.NativeImage {
  const { width, height } = image.getSize()
  const bgra = image.toBitmap()
  let top = height, left = width, bottom = -1, right = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (bgra[i + 3] < 24 || (bgra[i] > 235 && bgra[i + 1] > 235 && bgra[i + 2] > 235)) continue
      if (y < top) top = y
      if (y > bottom) bottom = y
      if (x < left) left = x
      if (x > right) right = x
    }
  }
  if (bottom < 0) return image
  const pad = Math.round(Math.max(width, height) * 0.01)
  const x = Math.max(0, left - pad)
  const y = Math.max(0, top - pad)
  return image.crop({ x, y, width: Math.min(width, right + pad + 1) - x, height: Math.min(height, bottom + pad + 1) - y })
}

function send(command: string): void {
  win?.webContents.send('menu', command)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'Echo',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      // Chromium's PDF viewer, for the Library.
      plugins: true
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => {
    win = null
    closeAllPresentations()
  })

  // Keep the app self-contained: no new windows, no navigation away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // The renderer holds the window open while notes are still being written.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win!, {
      type: 'warning',
      buttons: ['Keep Echo Open', 'Quit Anyway'],
      defaultId: 0,
      cancelId: 0,
      message: 'Echo is still writing a note.',
      detail: 'If you quit now, the note stays a draft and you can write it again later, but any dictation not yet transcribed will be lost.'
    })
    if (choice === 1) e.preventDefault()
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('file://')) e.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function buildMenu(): void {
  const isDev = !!process.env.ELECTRON_RENDERER_URL
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => send('settings') },
        {
          label: 'Lock Echo',
          accelerator: 'Cmd+Ctrl+L',
          click: () => {
            if (vault.data.settings.lockEnabled) closeAllPresentations()
            send('lock')
          }
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Note', accelerator: 'Cmd+N', click: () => send('new-note') },
        { label: 'New Client', accelerator: 'Cmd+Shift+N', click: () => send('new-client') },
        { label: 'Find Client…', accelerator: 'Cmd+K', click: () => send('find') },
        { type: 'separator' },
        { label: 'Export Backup…', click: () => send('backup-export') },
        { label: 'Restore Backup…', click: () => send('backup-import') },
        { label: 'Import from Previous Echo…', click: () => send('legacy-import') },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'Note',
      submenu: [
        { label: 'Start / Stop Dictation', accelerator: 'Cmd+R', click: () => send('record') },
        { label: 'Generate Note', accelerator: 'Cmd+Enter', click: () => send('generate') },
        { label: 'Copy Note for EHR', accelerator: 'Cmd+Shift+C', click: () => send('copy-note') },
        { label: 'Finalize Note', accelerator: 'Cmd+S', click: () => send('finalize') },
        { type: 'separator' },
        { label: 'Chart New Notes', accelerator: 'Cmd+Shift+E', click: () => send('chart') },
        { label: 'Next Note to Chart', accelerator: 'Cmd+]', click: () => send('chart-next') },
        { label: 'Previous Note to Chart', accelerator: 'Cmd+[', click: () => send('chart-prev') },
        { label: 'Open EHRs', accelerator: 'Alt+Cmd+E', click: () => send('open-ehrs') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Queue', accelerator: 'Cmd+0', click: () => send('queue') },
        { label: 'Scratchpad', accelerator: 'Cmd+Shift+P', click: () => send('scratchpad') },
        { label: 'Ask Claude', accelerator: 'Cmd+Shift+A', click: () => send('ask') },
        { label: 'Library', accelerator: 'Cmd+Shift+L', click: () => send('library') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? ([{ type: 'separator' }, { role: 'reload', accelerator: 'Cmd+Shift+R' }, { role: 'toggleDevTools' }] as Electron.MenuItemConstructorOptions[]) : [])
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Routine notes get the last three (minimum necessary); a discharge summary covers the whole episode. */
function priorNotesFor(note: Note): Note[] {
  const prior = finalizedNotes(note.clientId, note.id)
  return note.type === 'termination' ? prior : prior.slice(0, 3)
}

/** The letterhead with any image not chosen in the editor taken from the copies shipped with the app. */
function fullLetterhead(): Letterhead {
  const letterhead = vault.data.letterhead ?? DEFAULT_LETTERHEAD
  return {
    ...letterhead,
    logo: letterhead.logo || bundledImage('logo'),
    signers: letterhead.signers.map((s) => ({ ...s, signature: s.signature || bundledImage(s.id) }))
  }
}

/**
 * Prints a page to PDF in an offscreen window with scripts off. Plans and letters are rendered
 * from memory, so they never touch disk unencrypted except as the PDF the clinician asked for.
 */
async function printPage(url: string, options: Electron.PrintToPDFOptions): Promise<Buffer> {
  const page = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  try {
    await page.loadURL(url)
    return await page.webContents.printToPDF({ pageSize: 'Letter', preferCSSPageSize: true, printBackground: true, ...options })
  } finally {
    page.destroy()
  }
}

const htmlUrl = (html: string) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`

function renderPlanPdf(client: Client): Promise<Buffer> {
  if (!client.plan) throw new Error('This client has no treatment plan yet.')
  return printPage(htmlUrl(planToDocumentHtml(client.plan, client, vault.data.settings)), {
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: '<div style="font: 7.5pt -apple-system, Helvetica, sans-serif; color: #888; width: 100%; padding: 0 0.8in; display: flex; justify-content: space-between;"><span>Confidential health information</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>'
  })
}

function renderLetterPdf(letter: Letter): Promise<Buffer> {
  const letterhead = fullLetterhead()
  return printPage(htmlUrl(letterToDocumentHtml(letter, letterhead)), {
    displayHeaderFooter: !!letterhead.footer.trim(),
    headerTemplate: '<span></span>',
    footerTemplate: letterFooterTemplate(letterhead)
  })
}

function registerIpc(): void {
  ipcMain.handle('state:get', () => state())

  ipcMain.handle('settings:save', (_e, patch: Partial<Settings>) => {
    const model = vault.data.settings.transcribeModel
    vault.data.settings = { ...vault.data.settings, ...patch }
    vault.save()
    if (!vault.data.settings.localModel) local.stopLocal()
    else if (patch.localModel) local.ensureModel().catch(() => {})
    if (!MOCK && vault.data.settings.transcribeModel !== model) prepareTranscriber(vault.data.settings.transcribeModel).catch(() => {})
    return publicSettings()
  })

  ipcMain.handle('ehr:open', () => openEhrs(win, vault.data.settings.ehrs, vault.data.settings.ehrLayout))
  ipcMain.handle('ehr:show', (_e, id: string) => showEhr(vault.data.settings.ehrs, id))

  ipcMain.handle('settings:api-key', (_e, key: string) => {
    vault.data.apiKey = key.trim()
    vault.save()
    return publicSettings()
  })

  ipcMain.handle('ai:test', async () => {
    if (MOCK) return { ok: true, message: 'Demo mode is on (ECHO_MOCK_AI=1). No requests are sent.', models: [] }
    try {
      const models = await ai.listModels(requireKey())
      const { textModel, liveCoverage } = vault.data.settings
      const wanted = [...new Set(liveCoverage ? [textModel, ai.COVERAGE_MODEL] : [textModel])]
      const missing = wanted.filter((m) => !models.includes(m))
      const speech = transcriberStatus().state === 'ready' ? 'The speech model is ready.' : 'The speech model isn’t ready yet (see Transcription).'
      return {
        ok: missing.length === 0,
        message: missing.length ? `Connected, but this key cannot use: ${missing.join(', ')}` : `Connected to Claude. ${speech}`,
        models
      }
    } catch (err) {
      return { ok: false, message: (err as Error).message, models: [] }
    }
  })

  ipcMain.handle('client:upsert', (_e, client: Client) => {
    const i = vault.data.clients.findIndex((c) => c.id === client.id)
    if (i >= 0) vault.data.clients[i] = client
    else vault.data.clients.push(client)
    vault.save()
  })

  ipcMain.handle('client:delete', (_e, id: string) => {
    vault.data.clients = vault.data.clients.filter((c) => c.id !== id)
    vault.data.notes = vault.data.notes.filter((n) => n.clientId !== id)
    vault.data.chats = vault.data.chats.filter((t) => t.clientId !== id)
    for (const doc of vault.data.documents.filter((d) => d.clientId === id)) closePresentation(doc.id)
    vault.data.documents = vault.data.documents.filter((d) => d.clientId !== id)
    vault.save()
  })

  ipcMain.handle('note:upsert', (_e, note: Note) => {
    const i = vault.data.notes.findIndex((n) => n.id === note.id)
    if (i >= 0) vault.data.notes[i] = note
    else vault.data.notes.push(note)
    vault.save()
  })

  ipcMain.handle('note:delete', (_e, id: string) => {
    vault.data.notes = vault.data.notes.filter((n) => n.id !== id)
    vault.save()
  })

  ipcMain.handle('mic:request', async () => {
    if (MOCK) return true
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true
    return systemPreferences.askForMediaAccess('microphone')
  })

  ipcMain.handle('ai:transcribe', async (_e, pcm: ArrayBuffer) => {
    if (MOCK) return ai.mockTranscribe()
    return transcribe(vault.data.settings.transcribeModel, pcm)
  })
  ipcMain.handle('transcriber:status', () => transcriberStatus())

  ipcMain.handle('live:start', () => {
    // Demo mode has no live stream: dictation falls back to the (mock) batch transcript.
    if (MOCK) return false
    startLive(vault.data.settings.transcribeModel, (event) => win?.webContents.send('live', event))
    return true
  })
  ipcMain.on('live:audio', (_e, pcm: ArrayBuffer) => sendLiveAudio(pcm))
  ipcMain.on('live:commit', () => commitLive())
  ipcMain.handle('live:stop', () => stopLive())

  ipcMain.handle('ai:coverage', async (_e, noteId: string, dictation: string) => {
    const note = vault.data.notes.find((n) => n.id === noteId)
    if (!note) throw new Error('Note not found.')
    const client = vault.data.clients.find((c) => c.id === note.clientId)
    if (!client) throw new Error('Client not found.')
    if (MOCK) return mockCoverage(coachItems(note, client, dictation), dictation)
    return ai.coverage(requireKey(), note, client, dictation)
  })

  /** Settings with a one-note model override. Only listed Claude models are accepted from the renderer. */
  const withModel = (model?: string): Settings =>
    model && WRITING_MODELS.some((m) => m.id === model) ? { ...vault.data.settings, textModel: model } : vault.data.settings

  ipcMain.handle('ai:note', async (_e, noteId: string, model?: string) => {
    const note = vault.data.notes.find((n) => n.id === noteId)
    if (!note) throw new Error('Note not found.')
    const client = vault.data.clients.find((c) => c.id === note.clientId)
    if (!client) throw new Error('Client not found.')
    if (MOCK) return ai.mockGenerateNote(note, client)
    if (vault.data.settings.localModel && !model) return local.generateNote(vault.data.settings, note, client, priorNotesFor(note))
    return ai.generateNote(requireKey(), withModel(model), note, client, priorNotesFor(note))
  })

  ipcMain.handle('ai:amend', async (_e, noteId: string, followUp: string, flagged: string[], model?: string) => {
    const note = vault.data.notes.find((n) => n.id === noteId)
    if (!note) throw new Error('Note not found.')
    const client = vault.data.clients.find((c) => c.id === note.clientId)
    if (!client) throw new Error('Client not found.')
    if (MOCK) return ai.mockAmendNote(note, client, followUp)
    if (vault.data.settings.localModel && !model) return local.amendNote(vault.data.settings, note, client, priorNotesFor(note), followUp, flagged)
    return ai.amendNote(requireKey(), withModel(model), note, client, priorNotesFor(note), followUp, flagged)
  })

  ipcMain.handle('ai:plan', async (_e, clientId: string, dictation: string) => {
    const client = vault.data.clients.find((c) => c.id === clientId)
    if (!client) throw new Error('Client not found.')
    const notes = finalizedNotes(client.id)
    if (!dictation.trim() && notes.length === 0) throw new Error('There are no finalized notes to update the plan from yet. Dictate what’s changed instead.')
    if (MOCK) return ai.mockGeneratePlan(client)
    return ai.generatePlan(requireKey(), vault.data.settings, client, dictation, notes)
  })

  ipcMain.handle('ai:letter', async (_e, letter: Letter, clientId: string) => {
    const client = vault.data.clients.find((c) => c.id === clientId)
    if (!client) throw new Error('Client not found.')
    if (!letter.body.trim()) throw new Error('Jot down what the letter should say first.')
    const signers = (vault.data.letterhead ?? DEFAULT_LETTERHEAD).signers
      .filter((s) => letter.signerIds.includes(s.id))
      .map((s) => [signerLabel(s), s.title.trim()].filter(Boolean).join(', '))
    const input = { draft: letter.body, recipient: letter.recipient, subject: letter.subject, salutation: letter.salutation, closing: letter.closing, signers, clientName: client.name, pronouns: client.pronouns }
    if (MOCK) return ai.mockWriteLetter(input)
    return ai.writeLetter(requireKey(), vault.data.settings, input)
  })

  ipcMain.handle('ai:context', async (_e, clientId: string) => {
    const client = vault.data.clients.find((c) => c.id === clientId)
    if (!client) throw new Error('Client not found.')
    const notes = finalizedNotes(client.id)
    if (notes.length === 0) throw new Error('There are no finalized notes to rebuild the context from.')
    if (MOCK) return ai.mockRebuildContext(client)
    return ai.rebuildContext(requireKey(), vault.data.settings, client, notes)
  })

  ipcMain.handle('plan:pdf', async (_e, clientId: string) => {
    const client = vault.data.clients.find((c) => c.id === clientId)
    if (!client?.plan) throw new Error('This client has no treatment plan yet.')
    const result = await dialog.showSaveDialog(win!, {
      title: 'Save treatment plan as PDF',
      defaultPath: `Treatment Plan - ${client.name.replace(/[/\\:*?"<>|]/g, '')} - ${new Date().toISOString().slice(0, 10)}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, await renderPlanPdf(client), { mode: 0o600 })
    return result.filePath
  })

  ipcMain.handle('update:status', () => update)
  ipcMain.on('update:install', () => {
    if (update.state === 'ready') autoUpdater.quitAndInstall()
  })

  ipcMain.handle('letterhead:get', () => fullLetterhead())

  ipcMain.handle('letterhead:save', (_e, letterhead: Letterhead) => {
    // Only images chosen in the editor are stored; the shipped ones stay with the app, so a new release can update them.
    vault.data.letterhead = {
      ...letterhead,
      logo: letterhead.logo === bundledImage('logo') ? '' : letterhead.logo,
      signers: letterhead.signers.map((s) => (s.signature === bundledImage(s.id) ? { ...s, signature: '' } : s))
    }
    vault.save()
  })

  ipcMain.handle('letterhead:image', async (_e, kind: 'logo' | 'signature') => {
    const result = await dialog.showOpenDialog(win!, {
      title: kind === 'logo' ? 'Choose your logo' : 'Choose a signature',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
      properties: ['openFile']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const image = nativeImage.createFromPath(result.filePaths[0])
    if (image.isEmpty()) throw new Error('That file couldn’t be opened as an image.')
    return letterheadImage(image, kind)
  })

  ipcMain.handle('letter:pdf', async (_e, letter: Letter, clientName: string) => {
    const result = await dialog.showSaveDialog(win!, {
      title: 'Save letter as PDF',
      defaultPath: `Letter - ${clientName.replace(/[/\\:*?"<>|]/g, '')} - ${letter.date || new Date().toISOString().slice(0, 10)}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, await renderLetterPdf(letter), { mode: 0o600 })
    return result.filePath
  })

  ipcMain.handle('clipboard:write', (_e, text: string, html: string) =>
    clipboard.write([new ClipboardItem({ 'text/plain': text, 'text/html': html })])
  )

  ipcMain.handle('lock:available', () => systemPreferences.canPromptTouchID())

  ipcMain.handle('lock:unlock', async () => {
    try {
      await systemPreferences.promptTouchID('unlock Echo')
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('backup:export', async (_e, passphrase: string) => {
    const stamp = new Date().toISOString().slice(0, 10)
    const result = await dialog.showSaveDialog(win!, {
      title: 'Export encrypted backup',
      defaultPath: `Echo Backup ${stamp}.echobackup`,
      filters: [{ name: 'Echo Backup', extensions: ['echobackup'] }]
    })
    if (result.canceled || !result.filePath) return null
    vault.flush()
    writeFileSync(result.filePath, vault.exportBackup(passphrase), { mode: 0o600 })
    return result.filePath
  })

  ipcMain.handle('backup:import', async (_e, passphrase: string) => {
    const result = await dialog.showOpenDialog(win!, {
      title: 'Restore from backup',
      properties: ['openFile'],
      filters: [{ name: 'Echo Backup', extensions: ['echobackup'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    closeAllPresentations()
    clearTemp()
    histories.clear()
    vault.importBackup(readFileSync(result.filePaths[0]), passphrase)
    link.sync()
    return state()
  })

  ipcMain.handle('link:status', () => linkStatus())

  ipcMain.handle('link:pair', async () => {
    if (!vault.data.link) {
      vault.data.link = newPairing()
      vault.flush()
      link.sync()
    }
    return QRCode.toString(pairingUrl(vault.data.link, macName()), { type: 'svg', margin: 0, errorCorrectionLevel: 'M' })
  })

  ipcMain.handle('link:unpair', () => {
    vault.data.link = null
    vault.flush()
    linkError = ''
    link.sync()
    return linkStatus()
  })

  ipcMain.handle('inbox:remove', (_e, id: string) => {
    vault.data.inbox = vault.data.inbox.filter((m) => m.id !== id)
    vault.save()
  })
}

function registerLegacyImport(): void {
  ipcMain.handle('legacy:open', async (_e, password: string) => {
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose a backup exported from the previous Echo',
      properties: ['openFile'],
      filters: [{ name: 'Echo Backup', extensions: ['echobackup'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    legacy = readLegacyBackup(readFileSync(result.filePaths[0]), password)
    return summarizeLegacy(legacy, vault.data)
  })

  ipcMain.handle('legacy:import-client', (_e, clientId: string) => {
    const source = legacy?.find((c) => c.id === clientId)
    if (!legacy || !source) throw new Error('Open the backup again; it was closed.')
    const merged = mergeLegacy(vault.data, [source], vault.data.settings, randomUUID)
    for (const client of merged.clients) {
      const i = vault.data.clients.findIndex((c) => c.id === client.id)
      if (i >= 0) vault.data.clients[i] = client
      else vault.data.clients.push(client)
    }
    vault.data.notes.push(...merged.notes)
    vault.flush()
    return { ...merged, summaries: summarizeLegacy(legacy, vault.data) }
  })

  ipcMain.handle('legacy:close', () => {
    legacy = null
  })
}

/** The Library items a client has been given, for Ask Claude. */
const libraryDocuments = (clientId: string): ClientDocument[] => vault.data.documents.filter((d) => d.clientId === clientId && d.origin.kind === 'library')

/** Replies being written, by chat ID, so Stop can end one. */
const chatsInFlight = new Map<string, AbortController>()

function registerChat(): void {
  const findChat = (id: string): ChatThread => {
    const thread = vault.data.chats.find((t) => t.id === id)
    if (!thread) throw new Error('That chat was deleted.')
    return thread
  }
  const chatModel = (model: string): string => (CHAT_MODELS.some((m) => m.id === model) ? model : DEFAULT_CHAT_MODEL)

  ipcMain.handle('chat:list', (_e, clientId: string) =>
    vault.data.chats
      .filter((t) => t.clientId === clientId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(summarize)
  )

  ipcMain.handle('chat:get', (_e, id: string) => vault.data.chats.find((t) => t.id === id) ?? null)

  ipcMain.handle('chat:preview', (_e, clientId: string, model: string) => {
    const client = vault.data.clients.find((c) => c.id === clientId)
    if (!client) throw new Error('Client not found.')
    const notes = finalizedNotes(clientId)
    const documents = libraryDocuments(clientId)
    return { notes: notes.length, documents: documents.length, cost: startCost(buildChatSystem(client, notes, todayISO(), documents), chatModel(model)) }
  })

  ipcMain.handle('chat:send', (_e, clientId: string, threadId: string | null, text: string, model: string, retry = false) => {
    const client = vault.data.clients.find((c) => c.id === clientId)
    if (!client) throw new Error('Client not found.')
    if (!MOCK) requireKey()
    const now = new Date().toISOString()
    let thread: ChatThread
    if (threadId) {
      thread = findChat(threadId)
      if (chatsInFlight.has(thread.id)) throw new Error('Claude is still answering. Wait for the reply or press Stop.')
      thread.model = chatModel(model)
    } else {
      const notes = finalizedNotes(clientId)
      const documents = libraryDocuments(clientId)
      thread = {
        id: randomUUID(),
        clientId,
        title: chatTitle(text),
        model: chatModel(model),
        system: buildChatSystem(client, notes, todayISO(), documents),
        noteIds: notes.map((n) => n.id),
        documents: describeDocuments(documents, client),
        seen: { notes: notes.length, plan: (client.plan?.goals.length ?? 0) > 0, context: !!client.context.trim(), diagnoses: client.diagnoses.length, documents: documents.length, asOf: now },
        turns: [],
        createdAt: now,
        updatedAt: now
      }
      vault.data.chats.push(thread)
    }
    if (retry) {
      // Only the newest reply is redone, so everything before it stays exactly as Claude saw it.
      if (thread.turns[thread.turns.length - 1]?.role === 'assistant') thread.turns.pop()
      if (thread.turns[thread.turns.length - 1]?.role !== 'user') throw new Error('There’s no question to answer again.')
    } else {
      if (!text.trim()) throw new Error('Type a question first.')
      // Notes finalized since the chat started go out with this message, oldest first.
      const seen = new Set(thread.noteIds)
      const added = finalizedNotes(clientId).filter((n) => !seen.has(n.id)).reverse()
      thread.noteIds.push(...added.map((n) => n.id))
      // So are the client's Library documents, when they've changed (given, completed, scored).
      const documents = describeDocuments(libraryDocuments(clientId), client)
      const changed = documents !== (thread.documents ?? '')
      thread.documents = documents
      thread.turns.push({ id: randomUUID(), role: 'user', text: text.trim(), content: userContent(text, client, added, changed ? documents : undefined), addedNotes: added.length || undefined, documentsUpdated: changed || undefined, at: now })
    }
    thread.updatedAt = now
    vault.save()

    const controller = new AbortController()
    chatsInFlight.set(thread.id, controller)
    const emit = (event: ChatEvent) => win?.webContents.send('chat', event)
    const onDelta = (type: 'thinking' | 'text', delta: string) => emit({ threadId: thread.id, type, text: delta })
    const replyModel = thread.model
    const reply = MOCK ? ai.mockChat(onDelta, controller.signal) : ai.chat(requireKey(), replyModel, thread.system, thread.turns, onDelta, controller.signal)
    reply
      .then((r) => {
        const current = vault.data.chats.find((t) => t.id === thread.id)
        if (!current) return
        current.turns.push({ id: randomUUID(), role: 'assistant', text: r.text, content: r.content, thinking: r.thinking || undefined, model: replyModel, usage: r.usage, stopped: r.stopped || undefined, at: new Date().toISOString() })
        current.updatedAt = new Date().toISOString()
        vault.save()
        emit({ threadId: thread.id, type: 'done', thread: current })
      })
      .catch((err: Error) => {
        // The question stays in the chat so Try again can answer it; nothing after it was sent.
        emit({ threadId: thread.id, type: 'error', message: err.message, thread: vault.data.chats.find((t) => t.id === thread.id) ?? null })
      })
      .finally(() => chatsInFlight.delete(thread.id))
    return thread
  })

  ipcMain.on('chat:stop', (_e, id: string) => chatsInFlight.get(id)?.abort())

  ipcMain.handle('chat:model', (_e, id: string, model: string) => {
    const thread = findChat(id)
    thread.model = chatModel(model)
    vault.save()
    return thread
  })

  ipcMain.handle('chat:delete', (_e, id: string) => {
    chatsInFlight.get(id)?.abort()
    vault.data.chats = vault.data.chats.filter((t) => t.id !== id)
    vault.flush()
  })

  ipcMain.handle('chat:delete-all', (_e, clientId?: string) => {
    const doomed = vault.data.chats.filter((t) => !clientId || t.clientId === clientId)
    doomed.forEach((t) => chatsInFlight.get(t.id)?.abort())
    vault.data.chats = vault.data.chats.filter((t) => !doomed.includes(t))
    vault.flush()
    return doomed.length
  })
}

/** The resource library folder: the one chosen in the Library, else the practice's shared Google Drive copy, else the project's copy while developing. */
function resourceRoot(): string {
  return vault.data.settings.resourcesFolder || driveLibrary() || (app.isPackaged ? '' : join(app.getAppPath(), 'ClinicalResources'))
}

let driveLibraryPath = ''
/** Shared drives/Resources/Echo Library under Google Drive for desktop, whichever account is signed in. */
function driveLibrary(): string {
  if (driveLibraryPath && existsSync(driveLibraryPath)) return driveLibraryPath
  const cloud = join(app.getPath('home'), 'Library', 'CloudStorage')
  try {
    for (const account of readdirSync(cloud).filter((name) => name.startsWith('GoogleDrive-'))) {
      const shared = join(cloud, account, 'Shared drives')
      // Drive keeps the shared drive's name as typed, trailing space and all.
      const drive = existsSync(shared) ? readdirSync(shared).find((name) => name.trim() === 'Resources') : undefined
      const library = drive && join(shared, drive, 'Echo Library')
      if (library && existsSync(library)) return (driveLibraryPath = library)
    }
  } catch {
    // No Google Drive on this Mac.
  }
  return ''
}

/** A file in the library folder, refusing anything outside it. */
function libraryFile(rel: string): string {
  const root = resourceRoot()
  if (!root) throw new Error('Choose your ClinicalResources folder in the Library first.')
  const file = resolve(root, rel)
  if (!file.startsWith(resolve(root) + sep)) throw new Error('That resource is outside the library folder.')
  if (!existsSync(file)) throw new Error(`Couldn’t find ${rel} in ${root}. Was it moved? Rebuild the catalogue with scripts/catalog-resources.mjs.`)
  return file
}

/** Sites library links may open. */
const RESOURCE_SITES = ['https://contextualscience.org/', 'https://suicidesafetyplan.com/', 'https://cssrs.columbia.edu/', 'https://988lifeline.org/']

function registerResources(): void {
  const status = () => {
    const path = resourceRoot()
    return { path, found: !!path && existsSync(path) }
  }

  const partOf = (id: string, index: number): ResourcePart => {
    const part = resourceById(id)?.parts?.[index]
    if (!part) throw new Error('That resource isn’t in the library.')
    return part
  }

  // The viewer loads parts from echo-res://r/<id>/<part>[/thumb]. Only catalogued files are served.
  protocol.handle('echo-res', async (request) => {
    try {
      const [, id, index, thumb] = new URL(request.url).pathname.split('/')
      const part = partOf(id, Number(index))
      const rel = thumb === 'thumb' ? part.thumb : part.file
      if (!rel) return new Response('Not found', { status: 404 })
      const file = libraryFile(rel)
      const type = MIME[extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream'
      const headers: Record<string, string> = { 'Content-Type': type }
      // Pages and converted documents are shown as they are, without scripts or anything from the web.
      if (type.startsWith('text/html')) headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"
      return new Response(readFileSync(file), { headers })
    } catch (err) {
      return new Response((err as Error).message, { status: 404 })
    }
  })

  ipcMain.handle('resource:folder', () => status())

  ipcMain.handle('resource:choose-folder', async () => {
    const result = await dialog.showOpenDialog(win!, { title: 'Choose your ClinicalResources folder', properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    vault.data.settings.resourcesFolder = result.filePaths[0]
    vault.save()
    return status()
  })

  ipcMain.handle('resource:web', async (_e, id: string) => {
    const url = resourceById(id)?.url
    if (!url || !RESOURCE_SITES.some((site) => url.startsWith(site))) throw new Error('That resource has no web page.')
    await shell.openExternal(url)
  })

  ipcMain.handle('resource:app', async (_e, id: string, index: number) => {
    const part = partOf(id, index)
    const error = await shell.openPath(libraryFile(part.original ?? part.file))
    if (error) throw new Error(error)
  })

  ipcMain.handle('resource:quicklook', (_e, id: string, index: number) => {
    const part = partOf(id, index)
    win?.previewFile(libraryFile(part.original ?? part.file), part.label)
  })

  ipcMain.on('resource:reveal', (_e, id: string) => {
    const r = resourceById(id)
    const rel = r?.path ?? r?.parts?.[0]?.file
    if (rel) shell.showItemInFolder(libraryFile(rel))
  })
}

// ---------------------------------------------------------------------------
// Client documents
// ---------------------------------------------------------------------------

/** Files bigger than this are refused: they'd make backups slow and are rarely forms. */
const MAX_DOCUMENT_BYTES = 60 * 1024 * 1024

function findDocument(id: string): ClientDocument {
  const doc = vault.data.documents.find((d) => d.id === id)
  if (!doc) throw new Error('That document was deleted.')
  return doc
}

async function addDocument(clientId: string, title: string, origin: DocOrigin, bytes: Uint8Array, status: DocStatus, sections?: DocSection[]): Promise<ClientDocument> {
  if (!vault.data.clients.some((c) => c.id === clientId)) throw new Error('Client not found.')
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error(`${title} is larger than 60 MB. Save a smaller copy first.`)
  const { pageCount } = await inspectPdf(bytes)
  const now = new Date().toISOString()
  const doc: ClientDocument = {
    id: randomUUID(),
    clientId,
    title,
    origin,
    file: vault.writeFile(bytes),
    pageCount,
    status,
    completedAt: status === 'done' ? now : null,
    score: '',
    layout: null,
    marks: [],
    fields: {},
    ...(sections ? { sections } : {}),
    createdAt: now,
    updatedAt: now
  }
  vault.data.documents.push(doc)
  vault.save()
  return doc
}

/** A Library part as a PDF: documents as they are, ACBS pages printed, images placed on a page. */
async function libraryPdf(resourceId: string, index: number): Promise<Uint8Array> {
  const part = resourceById(resourceId)?.parts?.[index]
  if (!part || !assignablePart(part)) throw new Error('That resource can’t be given to a client as a document.')
  const file = libraryFile(part.file)
  if (part.format === 'pdf') return readFileSync(file)
  if (part.format === 'html') return printPage(`echo-res://r/${resourceId}/${index}`, { margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } })
  const ext = extname(file).slice(1).toLowerCase()
  if (ext !== 'png' && ext !== 'jpg' && ext !== 'jpeg') throw new Error('Only PNG and JPEG images can be added.')
  return imagesToPdf([{ bytes: readFileSync(file), type: ext === 'png' ? 'png' : 'jpg' }])
}

/** A resource as one PDF: every tab Echo can print, in order, and where each starts. */
async function libraryDocument(r: Resource): Promise<{ bytes: Uint8Array; sections?: DocSection[] }> {
  const parts = assignedParts(r)
  if (!parts.length) throw new Error('That resource can’t be given to a client as a document.')
  if (parts.length === 1) return { bytes: await libraryPdf(r.id, parts[0]) }
  const files: Uint8Array[] = []
  const labels: string[] = []
  for (const i of parts) {
    try {
      files.push(await libraryPdf(r.id, i))
      labels.push(partLabel(r.parts![i]))
    } catch (err) {
      console.warn(`Skipped ${r.parts![i].label} of ${r.title}:`, err)
    }
  }
  if (!files.length) throw new Error(`Echo couldn’t open ${r.title} from the Library.`)
  if (files.length === 1) return { bytes: files[0] }
  const { bytes, counts } = await combinePdfs(files)
  let start = 0
  const sections = labels.map((label, i) => {
    const section = { label, start, count: counts[i] }
    start += counts[i]
    return section
  })
  return { bytes, sections }
}

async function addFiles(clientId: string, paths: string[]): Promise<ClientDocument[]> {
  const added: ClientDocument[] = []
  const skipped: string[] = []
  for (const path of paths) {
    const ext = extname(path).slice(1).toLowerCase()
    const name = basename(path)
    try {
      if (statSync(path).size > MAX_DOCUMENT_BYTES) throw new Error('too large')
      const bytes = ext === 'pdf' ? readFileSync(path) : ext === 'png' || ext === 'jpg' || ext === 'jpeg' ? await imagesToPdf([{ bytes: readFileSync(path), type: ext === 'png' ? 'png' : 'jpg' }]) : null
      if (!bytes) throw new Error('not a PDF or image')
      added.push(await addDocument(clientId, titleFromFile(name), { kind: 'upload', filename: name }, bytes, 'done'))
    } catch {
      skipped.push(name)
    }
  }
  if (skipped.length && !added.length) throw new Error(`Echo couldn’t add ${skipped.join(', ')}. Documents must be PDFs, PNGs or JPEGs under 60 MB.`)
  return added
}

/** The finished PDF: the original with what was filled in drawn on, and only the pages chosen to go out. */
async function finishedPdf(doc: ClientDocument): Promise<Uint8Array> {
  return selectPages(await renderDocument(vault.readFile(doc.file), doc), exportedPages(doc))
}

// Opening in Preview and dragging out need a real file. Each is written to a private temporary
// folder, removed after a while and when Echo quits; leftovers from a crash go at the next start.
let tempRoot = ''
const TEMP_PREFIX = 'echo-documents-'
const tempFiles = new Map<string, { path: string; updatedAt: string }>()

function clearStaleTemp(): void {
  const dir = app.getPath('temp')
  try {
    for (const name of readdirSync(dir).filter((n) => n.startsWith(TEMP_PREFIX))) rmSync(join(dir, name), { recursive: true, force: true })
  } catch {
    // Nothing to clear.
  }
}

function clearTemp(): void {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = ''
  tempFiles.clear()
}

async function tempCopy(doc: ClientDocument): Promise<string> {
  const cached = tempFiles.get(doc.id)
  if (cached && cached.updatedAt === doc.updatedAt && existsSync(cached.path)) return cached.path
  if (!tempRoot) tempRoot = mkdtempSync(join(app.getPath('temp'), TEMP_PREFIX))
  const client = vault.data.clients.find((c) => c.id === doc.clientId)
  const dir = join(tempRoot, doc.id)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, exportFileName(doc, client?.name ?? ''))
  writeFileSync(path, await finishedPdf(doc), { mode: 0o600 })
  tempFiles.set(doc.id, { path, updatedAt: doc.updatedAt })
  setTimeout(() => {
    if (tempFiles.get(doc.id)?.path !== path) return
    rmSync(dir, { recursive: true, force: true })
    tempFiles.delete(doc.id)
  }, 15 * 60_000)
  return path
}

// The presentation window shows one document and nothing else, for sharing on screen.
// It has its own preload with only that document's calls, so no other client's data can reach it.
const presentations = new Map<string, BrowserWindow>()
/** The tab each presentation window opens on. */
const presentTabs = new Map<string, number>()

function presentationDoc(sender: Electron.WebContents): ClientDocument {
  for (const [id, w] of presentations) if (!w.isDestroyed() && w.webContents.id === sender.id) return findDocument(id)
  throw new Error('This window isn’t showing a document.')
}

function closePresentation(docId: string): void {
  presentations.get(docId)?.close()
}

/** Tells other windows a document changed. The presentation window only hears about its own document. */
function broadcastDocument(event: DocumentEvent, from?: Electron.WebContents): void {
  if (win && !win.isDestroyed() && win.webContents.id !== from?.id) win.webContents.send('document', event)
  const id = 'doc' in event ? event.doc.id : 'deleted' in event ? event.deleted : 'history' in event ? event.history.id : null
  const w = id ? presentations.get(id) : undefined
  if (w && !w.isDestroyed() && w.webContents.id !== from?.id) w.webContents.send('document', event)
}

const sendPresenting = () => win?.webContents.send('document', { presenting: [...presentations.keys()] } satisfies DocumentEvent)

function present(docId: string, tab?: number): void {
  const doc = findDocument(docId)
  const open = presentations.get(docId)
  if (open && !open.isDestroyed()) return open.focus()
  if (Number.isInteger(tab)) presentTabs.set(docId, tab!)
  else presentTabs.delete(docId)
  const w = new BrowserWindow({
    width: 980,
    height: 900,
    minWidth: 560,
    minHeight: 480,
    // Only the document's title: never the client's name, so the window can be picked to share without showing it.
    title: doc.title,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1d1c' : '#e9e7e2',
    show: false,
    webPreferences: { preload: join(__dirname, '../preload/present.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true }
  })
  presentations.set(docId, w)
  w.once('ready-to-show', () => w.show())
  w.on('page-title-updated', (e) => e.preventDefault())
  w.on('closed', () => {
    if (presentations.get(docId) === w) {
      presentations.delete(docId)
      presentTabs.delete(docId)
    }
    sendPresenting()
  })
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}#present`)
  else void w.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'present' })
  sendPresenting()
}

function closeAllPresentations(): void {
  for (const w of presentations.values()) if (!w.isDestroyed()) w.close()
}

// Undo and Redo for marks and fields live here, one history per document shared by every window,
// so it survives leaving the document and moving between the main and presentation windows.
// It lasts until Echo quits.
type Markup = Pick<ClientDocument, 'marks' | 'fields'>
const HISTORY_KEPT = 100
const histories = new Map<string, { undo: Markup[]; redo: Markup[] }>()
const markupOf = (doc: ClientDocument): Markup => ({ marks: doc.marks, fields: doc.fields })
const sameMarkup = (a: Markup, b: Markup) => JSON.stringify([a.marks, a.fields]) === JSON.stringify([b.marks, b.fields])

function historyFor(id: string): { undo: Markup[]; redo: Markup[] } {
  let h = histories.get(id)
  if (!h) histories.set(id, (h = { undo: [], redo: [] }))
  return h
}

const historyCounts = (id: string) => ({ id, undo: histories.get(id)?.undo.length ?? 0, redo: histories.get(id)?.redo.length ?? 0 })

/** Stores a document's new version. An undoable change adds the version it replaces to Undo and clears Redo. */
function storeDocument(next: ClientDocument, undoable: boolean, from?: Electron.WebContents): void {
  const i = vault.data.documents.findIndex((d) => d.id === next.id)
  if (i < 0) throw new Error('That document was deleted.')
  const current = vault.data.documents[i]
  if (undoable && !sameMarkup(current, next)) {
    const h = historyFor(next.id)
    h.undo = [...h.undo.slice(-(HISTORY_KEPT - 1)), markupOf(current)]
    h.redo = []
  }
  vault.data.documents[i] = next
  vault.save()
  broadcastDocument({ doc: next }, from)
  if (undoable) broadcastDocument({ history: historyCounts(next.id) })
}

/** Steps one change back (or forward) and tells every window, including the one that asked. */
function stepHistory(id: string, direction: 'undo' | 'redo'): void {
  const current = findDocument(id)
  const h = historyFor(id)
  const target = direction === 'undo' ? h.undo.pop() : h.redo.pop()
  if (!target) return
  ;(direction === 'undo' ? h.redo : h.undo).push(markupOf(current))
  const next: ClientDocument = { ...current, ...target, updatedAt: new Date().toISOString() }
  vault.data.documents = vault.data.documents.map((d) => (d.id === id ? next : d))
  vault.save()
  broadcastDocument({ doc: next })
  broadcastDocument({ history: historyCounts(id) })
}

function registerDocuments(): void {
  clearStaleTemp()

  ipcMain.handle('doc:assign', async (_e, clientId: string, resourceId: string) => {
    const r = resourceById(resourceId)
    if (!r) throw new Error('That resource isn’t in the library.')
    const { bytes, sections } = await libraryDocument(r)
    return addDocument(clientId, r.title, { kind: 'library', resourceId, part: assignedParts(r)[0] }, bytes, startsAsTodo(r) ? 'todo' : 'done', sections)
  })

  ipcMain.handle('doc:choose-files', async (_e, clientId: string) => {
    const result = await dialog.showOpenDialog(win!, {
      title: 'Add documents',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDFs and images', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }]
    })
    if (result.canceled) return []
    return addFiles(clientId, result.filePaths)
  })

  ipcMain.handle('doc:add-files', (_e, clientId: string, paths: string[]) => addFiles(clientId, paths.filter((p) => typeof p === 'string' && p)))

  ipcMain.handle('doc:save', (e, doc: ClientDocument, undoable = false) => {
    const current = findDocument(doc.id)
    // Which client and file a document belongs to never change.
    const next: ClientDocument = { ...doc, id: current.id, clientId: current.clientId, file: current.file, origin: current.origin, pageCount: current.pageCount, sections: current.sections, createdAt: current.createdAt }
    if (!current.sections) delete next.sections
    const pages = Array.isArray(doc.exportPages) ? exportedPages({ pageCount: current.pageCount, exportPages: doc.exportPages }) : []
    if (pages.length && pages.length < current.pageCount) next.exportPages = pages
    else delete next.exportPages
    storeDocument(next, undoable, e.sender)
  })

  ipcMain.handle('doc:history', (_e, id: string) => historyCounts(id))
  ipcMain.handle('doc:undo', (_e, id: string) => stepHistory(id, 'undo'))
  ipcMain.handle('doc:redo', (_e, id: string) => stepHistory(id, 'redo'))

  ipcMain.handle('doc:delete', (_e, id: string) => {
    closePresentation(id)
    histories.delete(id)
    vault.data.documents = vault.data.documents.filter((d) => d.id !== id)
    vault.save()
  })

  ipcMain.handle('doc:bytes', (_e, id: string) => new Uint8Array(vault.readFile(findDocument(id).file)))

  ipcMain.handle('doc:export', async (_e, id: string) => {
    const doc = findDocument(id)
    const client = vault.data.clients.find((c) => c.id === doc.clientId)
    const result = await dialog.showSaveDialog(win!, {
      title: 'Save document as PDF',
      defaultPath: exportFileName(doc, client?.name ?? ''),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, await finishedPdf(doc), { mode: 0o600 })
    return result.filePath
  })

  ipcMain.handle('doc:open', async (_e, id: string) => {
    const error = await shell.openPath(await tempCopy(findDocument(id)))
    if (error) throw new Error(error)
  })

  ipcMain.handle('doc:prepare-drag', async (_e, id: string) => {
    await tempCopy(findDocument(id))
  })

  ipcMain.on('doc:drag', (e, id: string) => {
    const cached = tempFiles.get(id)
    const doc = vault.data.documents.find((d) => d.id === id)
    if (!cached || !doc || cached.updatedAt !== doc.updatedAt || !existsSync(cached.path)) return
    e.sender.startDrag({ file: cached.path, icon: dragIcon() })
  })

  ipcMain.handle('doc:present', (_e, id: string, tab?: number) => present(id, tab))
  ipcMain.on('doc:stop-presenting', (_e, id: string) => closePresentation(id))

  ipcMain.handle('doc:from-letter', async (_e, letter: Letter, clientId: string) => {
    const title = `Letter${letter.recipient.trim() ? ` to ${letter.recipient.split('\n')[0].trim().slice(0, 60)}` : ''}`
    return addDocument(clientId, title, { kind: 'letter' }, await renderLetterPdf(letter), 'done')
  })

  ipcMain.handle('doc:from-plan', async (_e, clientId: string) => {
    const client = vault.data.clients.find((c) => c.id === clientId)
    if (!client) throw new Error('Client not found.')
    return addDocument(clientId, `Treatment plan (${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })})`, { kind: 'plan' }, await renderPlanPdf(client), 'done')
  })

  // The presentation window's calls. Each acts only on the document that window shows.
  ipcMain.handle('present:load', (e) => {
    const doc = presentationDoc(e.sender)
    const clientName = vault.data.clients.find((c) => c.id === doc.clientId)?.name ?? ''
    return { doc, bytes: new Uint8Array(vault.readFile(doc.file)), tab: presentTabs.get(doc.id), clientName }
  })

  ipcMain.handle('present:save', (e, incoming: ClientDocument, undoable = false) => {
    const current = presentationDoc(e.sender)
    if (incoming.id !== current.id) throw new Error('This window can only change its own document.')
    storeDocument({ ...current, layout: incoming.layout, marks: incoming.marks, fields: incoming.fields, updatedAt: new Date().toISOString() }, undoable, e.sender)
  })

  ipcMain.handle('present:history', (e) => historyCounts(presentationDoc(e.sender).id))
  ipcMain.handle('present:undo', (e) => stepHistory(presentationDoc(e.sender).id, 'undo'))
  ipcMain.handle('present:redo', (e) => stepHistory(presentationDoc(e.sender).id, 'redo'))

  ipcMain.handle('present:signers', (e) => {
    presentationDoc(e.sender)
    return fullLetterhead().signers
  })

  ipcMain.on('present:close', (e) => {
    for (const w of presentations.values()) if (!w.isDestroyed() && w.webContents.id === e.sender.id) w.close()
  })
}

let dragImage: Electron.NativeImage | null = null
/** A small page icon for dragging. */
function dragIcon(): Electron.NativeImage {
  if (!dragImage) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><path d="M14 4h26l12 12v44H14z" fill="#fff" stroke="#2e6b5e" stroke-width="3"/><path d="M40 4v12h12" fill="none" stroke="#2e6b5e" stroke-width="3"/><text x="33" y="46" font-family="Helvetica" font-weight="bold" font-size="13" fill="#2e6b5e" text-anchor="middle">PDF</text></svg>`
    dragImage = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
    if (dragImage.isEmpty()) dragImage = nativeImage.createFromNamedImage('NSMultipleDocuments')
  }
  return dragImage
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  html: 'text/html; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4'
}

function watchIdle(): void {
  const lockIfEnabled = () => {
    if (!vault.data.settings.lockEnabled) return
    closeAllPresentations()
    send('lock')
  }
  powerMonitor.on('lock-screen', lockIfEnabled)
  powerMonitor.on('suspend', lockIfEnabled)
  setInterval(() => {
    const { lockEnabled, lockMinutes } = vault.data.settings
    if (lockEnabled && powerMonitor.getSystemIdleTime() >= lockMinutes * 60) lockIfEnabled()
  }, 30_000)
}

// The library viewer's files come through their own scheme, so the PDF viewer and media elements can load them.
protocol.registerSchemesAsPrivileged([{ scheme: 'echo-res', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

app.setName('Echo')
// A dedicated folder so Echo never shares data with other apps named "Echo".
// ECHO_USER_DATA lets tests and demos run against a throwaway folder.
app.setPath('userData', process.env.ECHO_USER_DATA || join(app.getPath('appData'), 'Echo Notes'))

app.whenReady().then(() => {
  try {
    vault = new Vault()
  } catch (err) {
    dialog.showErrorBox('Echo could not open your data', (err as Error).message)
    app.quit()
    return
  }
  nativeTheme.themeSource = 'system'

  // Grant microphone access to our own page only; deny every other permission.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const media = details as { mediaTypes?: string[] }
    callback(permission === 'media' && (media.mediaTypes ?? []).every((t) => t === 'audio'))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')

  link = new LinkServer({
    pairing: () => vault.data.link,
    receive: receiveMemos,
    error: (message) => {
      linkError = message
      win?.webContents.send('link', linkStatus())
    }
  })
  link.sync()

  registerIpc()
  registerLegacyImport()
  registerChat()
  registerResources()
  registerDocuments()
  buildMenu()
  createWindow()
  watchIdle()

  // Load the speech model now (downloading it the first time) so the first dictation doesn't wait.
  onTranscriberStatus((status) => win?.webContents.send('transcriber', status))
  if (!MOCK) prepareTranscriber(vault.data.settings.transcribeModel).catch(() => {})

  // Check GitHub Releases for a newer version; it downloads in the background and installs on quit.
  // The sidebar shows the download and, once it's in, offers to restart.
  autoUpdater.on('update-available', (info) => setUpdate({ state: 'downloading', version: info.version, progress: 0 }))
  autoUpdater.on('download-progress', (p) => setUpdate({ ...update, state: 'downloading', progress: p.percent / 100 }))
  autoUpdater.on('update-downloaded', (info) => setUpdate({ state: 'ready', version: info.version, progress: 1 }))
  autoUpdater.on('error', () => update.state === 'downloading' && setUpdate({ state: 'idle', version: '', progress: 0 }))
  if (app.isPackaged && !MOCK) autoUpdater.checkForUpdatesAndNotify().catch(() => {})

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  clearTemp()
  link?.stop()
  stopLive()
  stopTranscriber()
  local.stopLocal()
  vault?.flush()
})
app.on('window-all-closed', () => {
  vault?.flush()
  app.quit()
})
