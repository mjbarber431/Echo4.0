import { contextBridge, ipcRenderer } from 'electron'
import type { LiveEvent } from '../shared/coach'
import type { EchoApi, MobileLinkStatus, MobileMemo, TranscriberStatus } from '../shared/types'

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
