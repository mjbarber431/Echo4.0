import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ChatEvent } from '../shared/chat'
import type { LiveEvent } from '../shared/coach'
import type { DocumentEvent, EchoApi, MobileLinkStatus, MobileMemo, TranscriberStatus, UpdateStatus } from '../shared/types'

const api: EchoApi = {
  getState: () => ipcRenderer.invoke('state:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  setApiKey: (key) => ipcRenderer.invoke('settings:api-key', key),
  testConnection: () => ipcRenderer.invoke('ai:test'),
  upsertClient: (client) => ipcRenderer.invoke('client:upsert', client),
  deleteClient: (id) => ipcRenderer.invoke('client:delete', id),
  upsertNote: (note) => ipcRenderer.invoke('note:upsert', note),
  deleteNote: (id) => ipcRenderer.invoke('note:delete', id),
  requestMic: () => ipcRenderer.invoke('mic:request'),
  transcribe: (pcm) => ipcRenderer.invoke('ai:transcribe', pcm),
  transcriberStatus: () => ipcRenderer.invoke('transcriber:status'),
  onTranscriber: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, status: TranscriberStatus) => handler(status)
    ipcRenderer.on('transcriber', listener)
    return () => ipcRenderer.removeListener('transcriber', listener)
  },
  updateStatus: () => ipcRenderer.invoke('update:status'),
  onUpdate: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, status: UpdateStatus) => handler(status)
    ipcRenderer.on('update', listener)
    return () => ipcRenderer.removeListener('update', listener)
  },
  installUpdate: () => ipcRenderer.send('update:install'),
  liveStart: () => ipcRenderer.invoke('live:start'),
  liveAudio: (pcm) => ipcRenderer.send('live:audio', pcm),
  liveCommit: () => ipcRenderer.send('live:commit'),
  liveStop: () => ipcRenderer.invoke('live:stop'),
  onLive: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, event: LiveEvent) => handler(event)
    ipcRenderer.on('live', listener)
    return () => ipcRenderer.removeListener('live', listener)
  },
  coverage: (noteId, dictation) => ipcRenderer.invoke('ai:coverage', noteId, dictation),
  generateNote: (noteId, model) => ipcRenderer.invoke('ai:note', noteId, model),
  amendNote: (noteId, followUp, flagged, model) => ipcRenderer.invoke('ai:amend', noteId, followUp, flagged, model),
  generatePlan: (clientId, dictation) => ipcRenderer.invoke('ai:plan', clientId, dictation),
  rebuildContext: (clientId) => ipcRenderer.invoke('ai:context', clientId),
  savePlanPdf: (clientId) => ipcRenderer.invoke('plan:pdf', clientId),
  getLetterhead: () => ipcRenderer.invoke('letterhead:get'),
  saveLetterhead: (letterhead) => ipcRenderer.invoke('letterhead:save', letterhead),
  chooseLetterheadImage: (kind) => ipcRenderer.invoke('letterhead:image', kind),
  saveLetterPdf: (letter, clientName) => ipcRenderer.invoke('letter:pdf', letter, clientName),
  writeLetter: (letter, clientId) => ipcRenderer.invoke('ai:letter', letter, clientId),
  listChats: (clientId) => ipcRenderer.invoke('chat:list', clientId),
  getChat: (threadId) => ipcRenderer.invoke('chat:get', threadId),
  sendChat: (clientId, threadId, text, model, retry) => ipcRenderer.invoke('chat:send', clientId, threadId, text, model, retry),
  stopChat: (threadId) => ipcRenderer.send('chat:stop', threadId),
  setChatModel: (threadId, model) => ipcRenderer.invoke('chat:model', threadId, model),
  deleteChat: (threadId) => ipcRenderer.invoke('chat:delete', threadId),
  deleteAllChats: (clientId) => ipcRenderer.invoke('chat:delete-all', clientId),
  chatPreview: (clientId, model) => ipcRenderer.invoke('chat:preview', clientId, model),
  onChat: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, event: ChatEvent) => handler(event)
    ipcRenderer.on('chat', listener)
    return () => ipcRenderer.removeListener('chat', listener)
  },
  resourceFolder: () => ipcRenderer.invoke('resource:folder'),
  chooseResourceFolder: () => ipcRenderer.invoke('resource:choose-folder'),
  openResourceWeb: (id) => ipcRenderer.invoke('resource:web', id),
  openResourceApp: (id, part) => ipcRenderer.invoke('resource:app', id, part),
  quickLookResource: (id, part) => ipcRenderer.invoke('resource:quicklook', id, part),
  revealResource: (id) => ipcRenderer.send('resource:reveal', id),
  assignDocument: (clientId, resourceId) => ipcRenderer.invoke('doc:assign', clientId, resourceId),
  chooseDocumentFiles: (clientId) => ipcRenderer.invoke('doc:choose-files', clientId),
  addDocumentFiles: (clientId, paths) => ipcRenderer.invoke('doc:add-files', clientId, paths),
  pathForFile: (file) => webUtils.getPathForFile(file),
  saveDocument: (doc, undoable) => ipcRenderer.invoke('doc:save', doc, undoable),
  documentHistory: (id) => ipcRenderer.invoke('doc:history', id),
  undoDocument: (id) => ipcRenderer.invoke('doc:undo', id),
  redoDocument: (id) => ipcRenderer.invoke('doc:redo', id),
  deleteDocument: (id) => ipcRenderer.invoke('doc:delete', id),
  documentBytes: (id) => ipcRenderer.invoke('doc:bytes', id),
  exportDocument: (id) => ipcRenderer.invoke('doc:export', id),
  openDocument: (id) => ipcRenderer.invoke('doc:open', id),
  prepareDocumentDrag: (id) => ipcRenderer.invoke('doc:prepare-drag', id),
  dragDocument: (id) => ipcRenderer.send('doc:drag', id),
  presentDocument: (id, tab) => ipcRenderer.invoke('doc:present', id, tab),
  stopPresenting: (id) => ipcRenderer.send('doc:stop-presenting', id),
  onDocument: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, event: DocumentEvent) => handler(event)
    ipcRenderer.on('document', listener)
    return () => ipcRenderer.removeListener('document', listener)
  },
  saveLetterToDocuments: (letter, clientId) => ipcRenderer.invoke('doc:from-letter', letter, clientId),
  savePlanToDocuments: (clientId) => ipcRenderer.invoke('doc:from-plan', clientId),
  copy: (text, html) => ipcRenderer.invoke('clipboard:write', text, html),
  canUseTouchId: () => ipcRenderer.invoke('lock:available'),
  unlock: () => ipcRenderer.invoke('lock:unlock'),
  exportBackup: (passphrase) => ipcRenderer.invoke('backup:export', passphrase),
  importBackup: (passphrase) => ipcRenderer.invoke('backup:import', passphrase),
  openLegacyBackup: (password) => ipcRenderer.invoke('legacy:open', password),
  importLegacyClient: (clientId) => ipcRenderer.invoke('legacy:import-client', clientId),
  closeLegacyBackup: () => ipcRenderer.invoke('legacy:close'),
  linkStatus: () => ipcRenderer.invoke('link:status'),
  linkPairingCode: () => ipcRenderer.invoke('link:pair'),
  linkUnpair: () => ipcRenderer.invoke('link:unpair'),
  onLink: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, status: MobileLinkStatus) => handler(status)
    ipcRenderer.on('link', listener)
    return () => ipcRenderer.removeListener('link', listener)
  },
  removeMemo: (id) => ipcRenderer.invoke('inbox:remove', id),
  onInbox: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, inbox: MobileMemo[]) => handler(inbox)
    ipcRenderer.on('inbox', listener)
    return () => ipcRenderer.removeListener('inbox', listener)
  },
  onMenu: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, command: string) => handler(command)
    ipcRenderer.on('menu', listener)
    return () => ipcRenderer.removeListener('menu', listener)
  }
}

contextBridge.exposeInMainWorld('echo', api)
