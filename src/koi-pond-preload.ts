import { contextBridge, ipcRenderer } from 'electron'
import type { PondView } from './koi-pond-store.ts'

contextBridge.exposeInMainWorld('koiPond', {
  getState: (): Promise<PondView> => ipcRenderer.invoke('pond:get-state'),
  rename: (id: string, name: string): Promise<boolean> => ipcRenderer.invoke('pond:rename', id, name),
  onState: (listener: (state: PondView) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: PondView) => listener(state)
    ipcRenderer.on('pond:state', wrapped)
    return () => { ipcRenderer.removeListener('pond:state', wrapped) }
  },
})
