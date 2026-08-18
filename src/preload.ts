import { ipcRenderer } from 'electron'
import type { RuntimePreference } from './catalog.ts'
import type { RuntimeView } from './runtime-controller.ts'

function element<T extends HTMLElement>(id: string): T {
  const value = document.querySelector<T>(`#${id}`)
  if (value === null) throw new Error(`runtime page is missing #${id}`)
  return value
}

function render(view: RuntimeView): void {
  element('shell-version').textContent = `Shell ${view.shellVersion} · 最低 DSH ${view.minimumDshVersion}`
  element('message').textContent = view.message
  const detail = view.currentVersion === undefined ? '' : `当前运行版本：${view.currentVersion}`
  element('detail').textContent = detail
  const progress = view.progress === undefined || view.progress.total === 0
    ? 0
    : Math.min(100, (view.progress.received / view.progress.total) * 100)
  element<HTMLDivElement>('progress-value').style.width = `${progress}%`
  element('cache').style.display = view.cachedCatalog ? 'block' : 'none'
  const error = element('error')
  error.textContent = view.error ?? ''
  error.style.display = view.error === undefined ? 'none' : 'block'

  const select = element<HTMLSelectElement>('version')
  const previous = select.value
  select.replaceChildren()
  const latest = document.createElement('option')
  latest.value = 'latest-compatible'
  latest.textContent = '自动选择最新兼容版本'
  select.append(latest)
  for (const version of view.versions) {
    const option = document.createElement('option')
    option.value = version.version
    const flags = [version.current ? '当前' : '', version.installed ? '已安装' : ''].filter(Boolean).join(' · ')
    option.textContent = flags.length === 0 ? version.version : `${version.version} (${flags})`
    select.append(option)
  }
  const preferred = view.preference.mode === 'latest-compatible' ? 'latest-compatible' : view.preference.version
  select.value = previous !== '' && [...select.options].some(option => option.value === previous) ? previous : preferred
  const busy = view.phase === 'checking' || view.phase === 'downloading' || view.phase === 'starting'
  select.disabled = busy
  element<HTMLButtonElement>('apply').disabled = busy || view.versions.length === 0
  element<HTMLButtonElement>('retry').disabled = busy
}

async function currentView(): Promise<RuntimeView> {
  return ipcRenderer.invoke('runtime:get-view') as Promise<RuntimeView>
}

window.addEventListener('DOMContentLoaded', () => {
  if (document.querySelector('#version') === null) return
  ipcRenderer.on('runtime:view', (_event, view: RuntimeView) => { render(view) })
  element<HTMLButtonElement>('retry').addEventListener('click', () => {
    void ipcRenderer.invoke('runtime:retry')
  })
  element<HTMLButtonElement>('apply').addEventListener('click', () => {
    const value = element<HTMLSelectElement>('version').value
    const preference: RuntimePreference = value === 'latest-compatible'
      ? { mode: 'latest-compatible' }
      : { mode: 'pinned', version: value }
    void ipcRenderer.invoke('runtime:set-preference', preference)
  })
  void currentView().then(render)
})
