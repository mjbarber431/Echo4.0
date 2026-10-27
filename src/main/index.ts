import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, session, shell, systemPreferences } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import QRCode from 'qrcode'
import { autoUpdater } from 'electron-updater'
import { WRITING_MODELS, type AppState, type Client, type MobileLinkStatus, type Note, type PublicSettings, type Settings, type UpdateStatus } from '../shared/types'
import { coachItems, mockCoverage } from '../shared/coach'
import { noteSortKey } from '../shared/compliance'
import { planToDocumentHtml } from '../shared/format'
import { DEFAULT_LETTERHEAD, letterFooterTemplate, letterToDocumentHtml, type Letter, type Letterhead } from '../shared/letter'
import { mergeLegacy, summarizeLegacy, type LegacyClient } from '../shared/legacy'
import { readLegacyBackup } from './legacyBackup'
import { Vault } from './vault'
import { LinkServer, macName, newPairing, pairingUrl, type LinkRequest } from './link'
import * as ai from './ai'
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
  return { settings: publicSettings(), clients: vault.data.clients, notes: vault.data.notes, inbox: vault.data.inbox }
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
      spellcheck: true
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => (win = null))

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
        { label: 'Lock Echo', accelerator: 'Cmd+Ctrl+L', click: () => send('lock') },
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
        { label: 'Finalize Note', accelerator: 'Cmd+S', click: () => send('finalize') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Queue', accelerator: 'Cmd+0', click: () => send('queue') },
        { label: 'Scratchpad', accelerator: 'Cmd+Shift+P', click: () => send('scratchpad') },
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
    // Rendered from memory in an offscreen window with scripts off, so the plan never touches disk unencrypted except as the PDF itself.
    const page = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    try {
      const html = planToDocumentHtml(client.plan, client, vault.data.settings)
      await page.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      const pdf = await page.webContents.printToPDF({
        pageSize: 'Letter',
        preferCSSPageSize: true,
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate: '<div style="font: 7.5pt -apple-system, Helvetica, sans-serif; color: #888; width: 100%; padding: 0 0.8in; display: flex; justify-content: space-between;"><span>Confidential health information</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>'
      })
      writeFileSync(result.filePath, pdf, { mode: 0o600 })
      return result.filePath
    } finally {
      page.destroy()
    }
  })

  ipcMain.handle('update:status', () => update)
  ipcMain.on('update:install', () => {
    if (update.state === 'ready') autoUpdater.quitAndInstall()
  })

  ipcMain.handle('letterhead:get', () => vault.data.letterhead ?? DEFAULT_LETTERHEAD)

  ipcMain.handle('letterhead:save', (_e, letterhead: Letterhead) => {
    vault.data.letterhead = letterhead
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
    // Cropped to the ink and scaled to what a printed page needs, so the vault stays small.
    const trimmed = trimToInk(image)
    const width = Math.min(trimmed.getSize().width, kind === 'logo' ? 600 : 1000)
    return trimmed.resize({ width, quality: 'best' }).toDataURL()
  })

  ipcMain.handle('letter:pdf', async (_e, letter: Letter, clientName: string) => {
    const result = await dialog.showSaveDialog(win!, {
      title: 'Save letter as PDF',
      defaultPath: `Letter - ${clientName.replace(/[/\\:*?"<>|]/g, '')} - ${letter.date || new Date().toISOString().slice(0, 10)}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (result.canceled || !result.filePath) return null
    const letterhead = vault.data.letterhead ?? DEFAULT_LETTERHEAD
    // As with the plan: rendered from memory with scripts off.
    const page = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    try {
      await page.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(letterToDocumentHtml(letter, letterhead))}`)
      const pdf = await page.webContents.printToPDF({
        pageSize: 'Letter',
        preferCSSPageSize: true,
        printBackground: true,
        displayHeaderFooter: !!letterhead.footer.trim(),
        headerTemplate: '<span></span>',
        footerTemplate: letterFooterTemplate(letterhead)
      })
      writeFileSync(result.filePath, pdf, { mode: 0o600 })
      return result.filePath
    } finally {
      page.destroy()
    }
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

function watchIdle(): void {
  const lockIfEnabled = () => {
    if (vault.data.settings.lockEnabled) send('lock')
  }
  powerMonitor.on('lock-screen', lockIfEnabled)
  powerMonitor.on('suspend', lockIfEnabled)
  setInterval(() => {
    const { lockEnabled, lockMinutes } = vault.data.settings
    if (lockEnabled && powerMonitor.getSystemIdleTime() >= lockMinutes * 60) send('lock')
  }, 30_000)
}

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
