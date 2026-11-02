import { contextBridge, ipcRenderer } from 'electron'
import type { DocumentEvent, PresentApi } from '../shared/types'

// The presentation window's bridge: its one document (with its client's name, for the stamp) and the signatures to sign it with.
// Nothing here can reach other clients, notes or settings.
const api: PresentApi = {
  load: () => ipcRenderer.invoke('present:load'),
  save: (doc, undoable) => ipcRenderer.invoke('present:save', doc, undoable),
  history: () => ipcRenderer.invoke('present:history'),
  undo: () => ipcRenderer.invoke('present:undo'),
  redo: () => ipcRenderer.invoke('present:redo'),
  signers: () => ipcRenderer.invoke('present:signers'),
  onDocument: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, event: DocumentEvent) => handler(event)
    ipcRenderer.on('document', listener)
    return () => ipcRenderer.removeListener('document', listener)
  },
  close: () => ipcRenderer.send('present:close')
}

contextBridge.exposeInMainWorld('echoPresent', api)
