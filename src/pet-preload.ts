import { ipcRenderer } from 'electron'

type PetMode = 'idle' | 'thinking' | 'speaking' | 'approval' | 'success' | 'error' | 'unavailable'
type ApprovalOutcome = 'allowed-once' | 'rejected'

const MAX_SKIN_DATA_URL_LENGTH = 3_000_000

interface PetApprovalView {
  id: string
  toolName: string
  sessionLabel: string
  reason?: string
  pendingCount: number
  responding: boolean
}

interface PetRendererState {
  mode: PetMode
  status?: string
  reply?: string
  sessionLabel?: string
  approval?: PetApprovalView
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.querySelector<T>('#' + id)
  if (value === null) throw new Error('pet page is missing #' + id)
  return value
}

function clipped(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return ''
  const points = Array.from(value.replace(/\s+/gu, ' ').trim())
  return points.length <= maximum ? points.join('') : points.slice(0, maximum - 1).join('') + '…'
}

function mode(value: unknown): PetMode {
  return value === 'thinking' || value === 'speaking' || value === 'approval'
    || value === 'success' || value === 'error' || value === 'unavailable'
    ? value
    : 'idle'
}

function approval(value: unknown): PetApprovalView | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (typeof input.id !== 'string' || input.id.length === 0 || input.id.length > 128
    || typeof input.toolName !== 'string' || typeof input.sessionLabel !== 'string'
    || typeof input.pendingCount !== 'number' || !Number.isSafeInteger(input.pendingCount)) return undefined
  return {
    id: input.id,
    toolName: clipped(input.toolName, 100),
    sessionLabel: clipped(input.sessionLabel, 100),
    ...(typeof input.reason === 'string' ? { reason: clipped(input.reason, 180) } : {}),
    pendingCount: Math.max(1, Math.min(99, input.pendingCount)),
    responding: input.responding === true,
  }
}

function skinUrl(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const dataUrl = (value as Record<string, unknown>).dataUrl
  if (dataUrl === null) return 'icon.png'
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_SKIN_DATA_URL_LENGTH) return undefined
  const prefix = 'data:image/png;base64,'
  if (!dataUrl.startsWith(prefix) || !/^[A-Za-z0-9+/]+={0,2}$/u.test(dataUrl.slice(prefix.length))) return undefined
  return dataUrl
}

function state(value: unknown): PetRendererState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { mode: 'unavailable', status: '宠物连接不可用' }
  const input = value as Record<string, unknown>
  const pending = approval(input.approval)
  return {
    mode: mode(input.mode),
    ...(typeof input.status === 'string' ? { status: clipped(input.status, 120) } : {}),
    ...(typeof input.reply === 'string' ? { reply: clipped(input.reply, 600) } : {}),
    ...(typeof input.sessionLabel === 'string' ? { sessionLabel: clipped(input.sessionLabel, 100) } : {}),
    ...(pending === undefined ? {} : { approval: pending }),
  }
}

let latest: PetRendererState = { mode: 'idle' }
let interaction: boolean | undefined

function render(value: unknown): void {
  latest = state(value)
  const pending = latest.approval
  const bubble = element<HTMLElement>('bubble')
  const approvalPanel = element<HTMLElement>('approval')
  const reply = clipped(latest.reply, 600)
  const status = clipped(latest.status, 120)
  document.body.dataset.state = latest.mode
  element('pet-page').dataset.state = latest.mode
  element('session-label').textContent = pending?.sessionLabel ?? latest.sessionLabel ?? 'DeepSeek Harness'
  element('status-text').textContent = status
  element('reply-text').textContent = pending === undefined ? reply : ''
  approvalPanel.hidden = pending === undefined
  element('approval-tool').textContent = pending?.toolName ?? ''
  element('approval-reason').textContent = pending?.reason ?? ''
  element('approval-count').textContent = pending === undefined || pending.pendingCount <= 1 ? '' : '待处理 ' + String(pending.pendingCount) + ' 项'
  element<HTMLButtonElement>('allow-approval').disabled = pending?.responding ?? false
  element<HTMLButtonElement>('reject-approval').disabled = pending?.responding ?? false
  bubble.hidden = pending === undefined && reply.length === 0 && status.length === 0
  bubble.setAttribute('aria-live', pending === undefined ? 'polite' : 'assertive')
}

async function respond(outcome: ApprovalOutcome): Promise<void> {
  const pending = latest.approval
  if (pending === undefined || pending.responding) return
  element<HTMLButtonElement>('allow-approval').disabled = true
  element<HTMLButtonElement>('reject-approval').disabled = true
  try {
    await ipcRenderer.invoke('pet:respond', pending.id, outcome)
  } catch {
    element('status-text').textContent = '审批已失效，请打开 DSH 查看'
  }
}

function updateInteraction(target: EventTarget | null): void {
  const interactive = target instanceof Element && target.closest('[data-interactive]') !== null
  if (interactive === interaction) return
  interaction = interactive
  ipcRenderer.send('pet:interaction', interactive)
}

window.addEventListener('DOMContentLoaded', () => {
  element('allow-approval').addEventListener('click', () => { void respond('allowed-once') })
  element('reject-approval').addEventListener('click', () => { void respond('rejected') })
  element('open-main').addEventListener('click', () => { ipcRenderer.send('pet:focus-main') })
  element('hide-pet').addEventListener('click', () => { ipcRenderer.send('pet:hide') })
  element('mascot').addEventListener('dblclick', () => { ipcRenderer.send('pet:focus-main') })
  element('mascot').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); ipcRenderer.send('pet:focus-main') }
  })
  document.addEventListener('mousemove', event => { updateInteraction(event.target) })
  document.addEventListener('mouseleave', () => { updateInteraction(null) })
  ipcRenderer.on('pet:state', (_event, value: unknown) => { render(value) })
  ipcRenderer.on('pet:skin', (_event, value: unknown) => {
    const next = skinUrl(value)
    if (next !== undefined) element<HTMLImageElement>('pet-skin').src = next
  })
  render({ mode: 'idle' })
  ipcRenderer.send('pet:ready')
})
