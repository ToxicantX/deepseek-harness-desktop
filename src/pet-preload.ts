import { ipcRenderer } from 'electron'
import { createPetCharacter, type PetCharacterAnimator } from './pet-character.ts'
import { DEFAULT_PET_SKIN, isDefaultPetSkin, parsePetSkinSource, selectPetSkinUrl, type PetSkinView } from './pet-skin.ts'

type PetMode = 'idle' | 'thinking' | 'speaking' | 'approval' | 'success' | 'error' | 'unavailable'
type ApprovalOutcome = 'allowed-once' | 'rejected'

const CLICK_DRAG_THRESHOLD = 4

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
let latestSkin: PetSkinView = DEFAULT_PET_SKIN
let character: PetCharacterAnimator | undefined
let petWindowVisible = false
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

function applySkin(): void {
  const builtIn = isDefaultPetSkin(latestSkin)
  const page = element<HTMLElement>('pet-page')
  const canvas = element<HTMLCanvasElement>('pet-character')
  const image = element<HTMLImageElement>('pet-skin')
  const visible = petWindowVisible && document.visibilityState === 'visible'
  page.dataset.customSkin = String(!builtIn)
  canvas.hidden = !builtIn
  image.hidden = builtIn || !visible
  if (!builtIn) {
    const source = selectPetSkinUrl(latestSkin, reducedMotion.matches, visible)
    if (image.getAttribute('src') !== source) image.src = source
  }
  character?.setReducedMotion(reducedMotion.matches)
  character?.setActive(builtIn && visible)
}
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
  character?.setMode(latest.mode)
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
  if (bubble.hidden) ipcRenderer.send('pet:set-shape', null)
  else {
    const bounds = bubble.getBoundingClientRect()
    ipcRenderer.send('pet:set-shape', {
      x: Math.floor(bounds.x),
      y: Math.floor(bounds.y),
      width: Math.ceil(bounds.width) + 8,
      height: Math.ceil(bounds.height),
    })
  }
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

function updateInteraction(clientX: number, clientY: number): void {
  const target = document.elementFromPoint(clientX, clientY)
  const interactive = target !== null && target.closest('[data-interactive]') !== null
  if (interactive === interaction) return
  interaction = interactive
  ipcRenderer.send('pet:interaction', interactive)
}

window.addEventListener('DOMContentLoaded', () => {
  character = createPetCharacter(element<HTMLCanvasElement>('pet-character'))
  character.setMode(latest.mode)
  element('allow-approval').addEventListener('click', () => { void respond('allowed-once') })
  element('reject-approval').addEventListener('click', () => { void respond('rejected') })
  element('open-main').addEventListener('click', () => { ipcRenderer.send('pet:focus-main') })
  element('hide-pet').addEventListener('click', () => { ipcRenderer.send('pet:hide') })
  const mascot = element<HTMLElement>('mascot')
  const skinImage = element<HTMLImageElement>('pet-skin')
  skinImage.addEventListener('error', () => {
    if (isDefaultPetSkin(latestSkin)) return
    latestSkin = DEFAULT_PET_SKIN
    applySkin()
  })
  let drag: { pointerId: number; startX: number; startY: number; moved: boolean } | undefined
  mascot.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    event.preventDefault()
    drag = { pointerId: event.pointerId, startX: event.screenX, startY: event.screenY, moved: false }
    character?.setDragging(true)
    mascot.setPointerCapture(event.pointerId)
    ipcRenderer.send('pet:drag-start', { x: event.screenX, y: event.screenY })
  })
  mascot.addEventListener('pointermove', event => {
    if (drag === undefined || drag.pointerId !== event.pointerId) return
    if (Math.abs(event.screenX - drag.startX) >= CLICK_DRAG_THRESHOLD
      || Math.abs(event.screenY - drag.startY) >= CLICK_DRAG_THRESHOLD) drag.moved = true
    ipcRenderer.send('pet:drag-move', { x: event.screenX, y: event.screenY })
  })
  const endActiveDrag = (pointerId: number): { moved: boolean } | undefined => {
    if (drag === undefined || drag.pointerId !== pointerId) return undefined
    const finished = { moved: drag.moved }
    drag = undefined
    character?.setDragging(false)
    if (mascot.hasPointerCapture(pointerId)) mascot.releasePointerCapture(pointerId)
    ipcRenderer.send('pet:drag-end')
    return finished
  }
  const finishDrag = (event: PointerEvent, open: boolean): void => {
    const finished = endActiveDrag(event.pointerId)
    if (finished === undefined) return
    updateInteraction(event.clientX, event.clientY)
    if (open && !finished.moved) ipcRenderer.send('pet:focus-main')
  }
  const cancelActiveDrag = (): void => {
    if (drag === undefined) return
    endActiveDrag(drag.pointerId)
    updateInteraction(-1, -1)
  }
  mascot.addEventListener('pointerup', event => { finishDrag(event, true) })
  mascot.addEventListener('pointercancel', event => { finishDrag(event, false) })
  mascot.addEventListener('lostpointercapture', event => {
    if (endActiveDrag(event.pointerId) !== undefined) updateInteraction(-1, -1)
  })
  window.addEventListener('blur', cancelActiveDrag)
  window.addEventListener('pagehide', () => { cancelActiveDrag(); character?.dispose() })
  document.addEventListener('visibilitychange', applySkin)
  mascot.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); ipcRenderer.send('pet:focus-main') }
  })
  document.addEventListener('mousemove', event => { updateInteraction(event.clientX, event.clientY) })
  document.addEventListener('mouseleave', () => { updateInteraction(-1, -1) })
  ipcRenderer.on('pet:state', (_event, value: unknown) => { render(value) })
  ipcRenderer.on('pet:visibility', (_event, visible: unknown) => {
    if (typeof visible !== 'boolean') return
    petWindowVisible = visible
    applySkin()
  })
  ipcRenderer.on('pet:skin', (_event, value: unknown) => {
    const next = parsePetSkinSource(value)
    if (next !== undefined) { latestSkin = next; applySkin() }
  })
  reducedMotion.addEventListener('change', applySkin)
  applySkin()
  render({ mode: 'idle' })
  ipcRenderer.send('pet:ready')
})
