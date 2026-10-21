import type { SearchSettingsView } from './search-settings.ts'

export function installSearchSettings(
  read: () => Promise<SearchSettingsView>,
  save: (value: unknown) => Promise<{ saved: boolean; settings: SearchSettingsView }>,
): void {
  const element = <T extends HTMLElement>(id: string) => document.getElementById('search-' + id) as T
  const provider = element<HTMLSelectElement>('provider')
  const status = element<HTMLParagraphElement>('status')
  const saveButton = element<HTMLButtonElement>('save')
  const reload = element<HTMLButtonElement>('reload')
  let snapshot: SearchSettingsView | undefined
  let busy = false
  const message = (text: string, kind = '') => { status.textContent = text; status.dataset.kind = kind }
  const lock = (value: boolean) => {
    busy = value
    for (const input of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('#search-form input, #search-form select, #search-form button')) input.disabled = value
    saveButton.disabled = value || snapshot === undefined
  }
  const display = (value: SearchSettingsView) => {
    snapshot = value; provider.value = value.provider
    for (const id of ['exa', 'perplexity'] as const) {
      element<HTMLInputElement>(id + '-url').value = value[id].baseURL
      const key = element<HTMLInputElement>(id + '-key')
      key.value = ''; key.placeholder = value[id].hasKey ? '已保存，留空保留原密钥' : '未保存密钥'
      element<HTMLInputElement>(id + '-remove').checked = false
    }
    if (value.provider === 'perplexity' || value.perplexity.hasKey) element<HTMLDetailsElement>('perplexity-details').open = true
  }
  const load = async () => {
    if (busy) return
    lock(true)
    try { display(await read()); message('已加载') }
    catch { message('读取失败，请重新加载搜索设置。', 'error') }
    finally { lock(false) }
  }
  reload.addEventListener('click', () => { void load() })
  provider.addEventListener('change', () => { if (provider.value === 'perplexity') element<HTMLDetailsElement>('perplexity-details').open = true })
  for (const id of ['exa', 'perplexity']) {
    const key = element<HTMLInputElement>(id + '-key'), remove = element<HTMLInputElement>(id + '-remove')
    key.addEventListener('input', () => { if (key.value !== '') remove.checked = false })
    remove.addEventListener('change', () => { if (remove.checked) key.value = '' })
  }
  element<HTMLFormElement>('form').addEventListener('submit', event => {
    event.preventDefault()
    if (busy || !snapshot) return
    const channel = (id: string) => ({ baseURL: element<HTMLInputElement>(id + '-url').value,
      apiKey: element<HTMLInputElement>(id + '-key').value, removeKey: element<HTMLInputElement>(id + '-remove').checked })
    const input = { provider: provider.value, expectedRevision: snapshot.revision, exa: channel('exa'), perplexity: channel('perplexity') }
    lock(true); message('正在保存并应用...')
    void save(input).then(result => {
      if (result.saved) { display(result.settings); message('已保存并应用', 'success') }
      else message('已取消，设置未保存')
    }).catch((error: unknown) => {
      const text = error instanceof Error ? error.message : '保存失败，请重试。'
      // Never echo submitted key text, including an unexpected IPC error.
      const safe = [input.exa.apiKey, input.perplexity.apiKey].filter(Boolean).reduce((message, key) => message.replaceAll(key, '[hidden]'), text)
      message(safe, 'error')
    }).finally(() => { lock(false) })
  })
  void load()
}
