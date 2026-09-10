import { contextBridge, ipcRenderer } from 'electron'
import type { PondView } from './koi-pond-store.ts'

window.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault()
    void ipcRenderer.invoke('pond:close').catch(console.error)
  }
})

contextBridge.exposeInMainWorld('koiPond', {
  close: (): Promise<void> => ipcRenderer.invoke('pond:close'),
  getState: (): Promise<PondView> => ipcRenderer.invoke('pond:get-state'),
  rename: (id: string, name: string): Promise<boolean> => ipcRenderer.invoke('pond:rename', id, name),
  onVisibility: (listener: (visible: boolean) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, visible: boolean) => listener(visible)
    ipcRenderer.on('pond:visibility', receive)
    return () => { ipcRenderer.removeListener('pond:visibility', receive) }
  },
  onState: (listener: (state: PondView) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: PondView) => listener(state)
    ipcRenderer.on('pond:state', wrapped)
    return () => { ipcRenderer.removeListener('pond:state', wrapped) }
  },
  onRunningSessions: (listener: (sessions: Array<{ id: string; startedAt: number }>) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, sessions: Array<{ id: string; startedAt: number }>) => listener(sessions)
    ipcRenderer.on('pond:running-sessions', receive)
    return () => { ipcRenderer.removeListener('pond:running-sessions', receive) }
  },
})
