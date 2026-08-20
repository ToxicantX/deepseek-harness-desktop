export type PetCharacterMode = 'idle' | 'thinking' | 'speaking' | 'approval' | 'success' | 'error' | 'unavailable' | 'dragging'

type EyeStyle = 'normal' | 'blink' | 'focus' | 'wide' | 'happy' | 'error' | 'sleepy'

export interface PetCharacterSpriteSpec {
  source: string
  frameCount: number
  frameMs: number
  reducedMotionFrame: number
  oneShot: boolean
}

export const PET_CHARACTER_SPRITES: Readonly<Record<PetCharacterMode, PetCharacterSpriteSpec>> = {
  idle: { source: 'pet-character/runtime/idle.png', frameCount: 8, frameMs: 350, reducedMotionFrame: 0, oneShot: false },
  thinking: { source: 'pet-character/runtime/thinking.png', frameCount: 8, frameMs: 150, reducedMotionFrame: 3, oneShot: false },
  speaking: { source: 'pet-character/runtime/speaking.png', frameCount: 6, frameMs: 110, reducedMotionFrame: 2, oneShot: false },
  approval: { source: 'pet-character/runtime/approval.png', frameCount: 6, frameMs: 150, reducedMotionFrame: 3, oneShot: false },
  success: { source: 'pet-character/runtime/success.png', frameCount: 8, frameMs: 100, reducedMotionFrame: 7, oneShot: true },
  error: { source: 'pet-character/runtime/error.png', frameCount: 6, frameMs: 100, reducedMotionFrame: 5, oneShot: true },
  unavailable: { source: 'pet-character/runtime/unavailable.png', frameCount: 8, frameMs: 300, reducedMotionFrame: 4, oneShot: false },
  dragging: { source: 'pet-character/runtime/dragging.png', frameCount: 4, frameMs: 140, reducedMotionFrame: 0, oneShot: false },
}

export function petCharacterSpriteFrame(mode: PetCharacterMode, elapsedMs: number, reducedMotion = false): number {
  const spec = PET_CHARACTER_SPRITES[mode]
  if (reducedMotion) return spec.reducedMotionFrame
  const elapsedFrame = Math.floor(Math.max(0, elapsedMs) / spec.frameMs)
  return spec.oneShot ? Math.min(elapsedFrame, spec.frameCount - 1) : elapsedFrame % spec.frameCount
}

export interface PetCharacterPose {
  mode: PetCharacterMode
  frame: number
  offsetX: number
  offsetY: number
  eye: EyeStyle
  mouth: 0 | 1 | 2
  armLift: number
  effect: number
  statusColor: string
}

const FRAME_COUNTS: Record<PetCharacterMode, number> = {
  idle: 28,
  thinking: 8,
  speaking: 6,
  approval: 6,
  success: 8,
  error: 6,
  unavailable: 8,
  dragging: 4,
}

const FRAME_MS: Record<PetCharacterMode, number> = {
  idle: 100,
  thinking: 130,
  speaking: 110,
  approval: 100,
  success: 90,
  error: 90,
  unavailable: 250,
  dragging: 120,
}

const STATIC_FRAMES: Record<PetCharacterMode, number> = {
  idle: 0,
  thinking: 2,
  speaking: 1,
  approval: 0,
  success: 6,
  error: 0,
  unavailable: 0,
  dragging: 0,
}

const STATUS_COLORS: Record<PetCharacterMode, string> = {
  idle: '#38b88f',
  thinking: '#e9a825',
  speaking: '#2699d6',
  approval: '#f27c35',
  success: '#30a66f',
  error: '#df4d5b',
  unavailable: '#7d8794',
  dragging: '#8f67d8',
}

function loopFrame(mode: PetCharacterMode, elapsedMs: number, reducedMotion: boolean): number {
  if (reducedMotion) return STATIC_FRAMES[mode]
  const elapsedFrame = Math.floor(Math.max(0, elapsedMs) / FRAME_MS[mode])
  if (mode === 'success' || mode === 'error') return Math.min(elapsedFrame, FRAME_COUNTS[mode] - 1)
  return elapsedFrame % FRAME_COUNTS[mode]
}

export function petCharacterPose(mode: PetCharacterMode, elapsedMs: number, reducedMotion = false): PetCharacterPose {
  const frame = loopFrame(mode, elapsedMs, reducedMotion)
  const base = { mode, frame, offsetX: 0, offsetY: 0, eye: 'normal' as EyeStyle, mouth: 0 as const, armLift: 0, effect: frame, statusColor: STATUS_COLORS[mode] }
  if (mode === 'idle') {
    const bob = [0, 0, -1, -1, -2, -2, -1, -1][frame % 8] ?? 0
    return { ...base, offsetY: bob, eye: frame === 24 || frame === 25 ? 'blink' : 'normal' }
  }
  if (mode === 'thinking') return { ...base, offsetY: [0, -1, -2, -1][frame % 4] ?? 0, eye: 'focus', armLift: frame % 2 }
  if (mode === 'speaking') return { ...base, offsetY: frame % 2 === 0 ? -1 : -2, mouth: frame % 3 === 0 ? 2 : 1, armLift: frame % 2, eye: 'normal' }
  if (mode === 'approval') return { ...base, offsetX: [-2, 2, -1, 1, 0, 0][frame] ?? 0, eye: 'wide', mouth: 1, armLift: 4 }
  if (mode === 'success') return { ...base, offsetY: [0, -4, -8, -6, -3, 0, 0, 0][frame] ?? 0, eye: 'happy', armLift: frame < 5 ? 7 : 2 }
  if (mode === 'error') return { ...base, offsetX: [-3, 3, -3, 3, -1, 0][frame] ?? 0, eye: 'error', mouth: 2, armLift: 2 }
  if (mode === 'unavailable') return { ...base, offsetY: 2, eye: frame === 6 ? 'blink' : 'sleepy', mouth: 0, armLift: -1 }
  return { ...base, offsetY: frame % 2 === 0 ? -2 : -3, eye: 'wide', mouth: 1, armLift: 8 }
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath()
  context.moveTo(x + radius, y)
  context.lineTo(x + width - radius, y)
  context.quadraticCurveTo(x + width, y, x + width, y + radius)
  context.lineTo(x + width, y + height - radius)
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height)
  context.lineTo(x + radius, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - radius)
  context.lineTo(x, y + radius)
  context.quadraticCurveTo(x, y, x + radius, y)
  context.closePath()
}

function fillRounded(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number, color: string): void {
  roundedRect(context, x, y, width, height, radius)
  context.fillStyle = color
  context.fill()
}

function drawEye(context: CanvasRenderingContext2D, x: number, y: number, style: EyeStyle, mirrored: boolean): void {
  context.fillStyle = '#1c3540'
  if (style === 'blink' || style === 'sleepy') { context.fillRect(x - 4, y + 2, 8, 2); return }
  if (style === 'happy') {
    context.fillRect(x - 4, y + 2, 3, 2)
    context.fillRect(x - 1, y, 3, 2)
    context.fillRect(x + 2, y + 2, 2, 2)
    return
  }
  if (style === 'error') {
    context.lineWidth = 2
    context.strokeStyle = '#a72f43'
    context.beginPath()
    context.moveTo(x - 3, y - 2)
    context.lineTo(x + 3, y + 4)
    context.moveTo(x + 3, y - 2)
    context.lineTo(x - 3, y + 4)
    context.stroke()
    return
  }
  const width = style === 'wide' ? 7 : 6
  const height = style === 'wide' ? 8 : 6
  const shift = style === 'focus' ? (mirrored ? -2 : 2) : 0
  fillRounded(context, x - width / 2 + shift, y - height / 2, width, height, 2, '#1c3540')
  if (style === 'wide') { context.fillStyle = '#ffffff'; context.fillRect(x - 1 + shift, y - 2, 2, 2) }
}

function drawEffects(context: CanvasRenderingContext2D, pose: PetCharacterPose): void {
  const frame = pose.effect
  if (pose.mode === 'thinking') {
    const dots: readonly (readonly [number, number])[] = [[17, 26], [13, 18], [19, 12]]
    for (let index = 0; index < dots.length; index += 1) {
      const dot = dots[(index + frame) % dots.length]
      if (dot === undefined) continue
      context.fillStyle = index === 0 ? '#f2b93b' : '#8f67d8'
      context.fillRect(dot[0], dot[1], 4, 4)
    }
  } else if (pose.mode === 'speaking') {
    context.fillStyle = '#2699d6'
    const heights = [5, 10, 15]
    for (let index = 0; index < heights.length; index += 1) {
      const height = heights[(index + frame) % heights.length] ?? 5
      context.fillRect(12 - index * 4, 43 - height / 2, 2, height)
    }
  } else if (pose.mode === 'approval') {
    fillRounded(context, 72, 8, 17, 22, 6, frame % 2 === 0 ? '#f27c35' : '#ffd05a')
    context.fillStyle = '#292d35'
    context.fillRect(79, 12, 3, 9)
    context.fillRect(79, 24, 3, 3)
  } else if (pose.mode === 'success') {
    context.fillStyle = frame % 2 === 0 ? '#ffd05a' : '#38b88f'
    context.fillRect(14, 18, 4, 12)
    context.fillRect(10, 22, 12, 4)
    context.fillRect(79, 34, 3, 9)
    context.fillRect(76, 37, 9, 3)
  } else if (pose.mode === 'error') {
    context.fillStyle = '#df4d5b'
    context.fillRect(9, 25, 8, 3)
    context.fillRect(13, 21, 3, 11)
    context.fillRect(80, 20, 3, 12)
    context.fillRect(76, 25, 11, 3)
  } else if (pose.mode === 'unavailable') {
    context.fillStyle = '#7d8794'
    context.fillRect(74, 17, 10, 3)
    context.fillRect(81, 20, 3, 3)
    context.fillRect(74, 23, 10, 3)
    context.fillRect(81, 6, 7, 2)
    context.fillRect(86, 8, 2, 2)
    context.fillRect(81, 10, 7, 2)
  } else if (pose.mode === 'dragging') {
    context.fillStyle = '#8f67d8'
    context.fillRect(7, 35, 10, 2)
    context.fillRect(10, 42, 7, 2)
    context.fillRect(79, 35, 10, 2)
    context.fillRect(79, 42, 7, 2)
  }
}

export function drawPetCharacter(canvas: HTMLCanvasElement, pose: PetCharacterPose): void {
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('pet character canvas is unavailable')
  const scaleX = canvas.width / 96
  const scaleY = canvas.height / 96
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.setTransform(scaleX, 0, 0, scaleY, 0, 0)
  context.imageSmoothingEnabled = false

  const x = pose.offsetX
  const y = pose.offsetY
  context.fillStyle = 'rgba(20, 28, 38, 0.2)'
  context.beginPath()
  context.ellipse(48, 86, pose.mode === 'dragging' ? 21 : 27, 5, 0, 0, Math.PI * 2)
  context.fill()

  context.lineCap = 'round'
  context.lineWidth = 5
  context.strokeStyle = '#707b88'
  context.beginPath()
  context.moveTo(35 + x, 65 + y)
  context.lineTo(25 + x, 69 + y - pose.armLift)
  context.moveTo(61 + x, 65 + y)
  context.lineTo(71 + x, 69 + y - pose.armLift)
  context.stroke()

  fillRounded(context, 33 + x, 55 + y, 30, pose.mode === 'dragging' ? 25 : 29, 8, '#f0f3f6')
  context.fillStyle = '#d6dce3'
  context.fillRect(38 + x, 61 + y, 20, 3)
  fillRounded(context, 39 + x, 75 + y, 7, 11, 3, '#4d5866')
  fillRounded(context, 51 + x, 75 + y, 7, 11, 3, '#4d5866')
  context.fillStyle = '#f2a93b'
  context.fillRect(45 + x, 68 + y, 6, 6)

  context.strokeStyle = '#56616f'
  context.lineWidth = 3
  context.beginPath()
  context.moveTo(48 + x, 20 + y)
  context.lineTo(48 + x, 11 + y)
  context.stroke()
  context.fillStyle = pose.statusColor
  context.beginPath()
  context.arc(48 + x, 8 + y, pose.mode === 'approval' ? 5 : 4, 0, Math.PI * 2)
  context.fill()

  fillRounded(context, 19 + x, 18 + y, 58, 43, 12, '#252b34')
  context.fillStyle = '#f2a93b'
  context.fillRect(16 + x, 31 + y, 5, 16)
  context.fillRect(75 + x, 31 + y, 5, 16)
  fillRounded(context, 25 + x, 24 + y, 46, 30, 8, pose.mode === 'error' ? '#ffd9df' : pose.mode === 'unavailable' ? '#d9dee4' : '#c9f8e8')

  drawEye(context, 37 + x, 37 + y, pose.eye, false)
  drawEye(context, 59 + x, 37 + y, pose.eye, true)
  context.fillStyle = pose.mode === 'error' ? '#a72f43' : '#1c3540'
  if (pose.mouth === 2) fillRounded(context, 43 + x, 45 + y, 10, 6, 2, context.fillStyle as string)
  else if (pose.mouth === 1) context.fillRect(44 + x, 47 + y, 8, 3)
  else context.fillRect(45 + x, 47 + y, 6, 2)

  context.save()
  context.translate(x, y)
  drawEffects(context, pose)
  context.restore()
}

export function drawPetCharacterSprite(canvas: HTMLCanvasElement, image: HTMLImageElement, frame: number): void {
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('pet character canvas is unavailable')
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.imageSmoothingEnabled = false
  context.drawImage(image, frame * 192, 0, 192, 192, 0, 0, canvas.width, canvas.height)
}

interface LoadedPetCharacterSprite {
  image: HTMLImageElement
  ready: boolean
}

export interface PetCharacterClock {
  now(): number
  requestFrame(callback: FrameRequestCallback): number
  cancelFrame(handle: number): void
}

export class PetCharacterAnimator {
  private mode: Exclude<PetCharacterMode, 'dragging'> = 'idle'
  private dragging = false
  private reducedMotion = false
  private active = false
  private startedAt: number
  private frameHandle: number | undefined
  private lastFrameKey: string | undefined
  private readonly sprites = new Map<PetCharacterMode, LoadedPetCharacterSprite>()
  private disposed = false

  constructor(private readonly canvas: HTMLCanvasElement, private readonly clock: PetCharacterClock) {
    this.startedAt = clock.now()
    this.draw(clock.now())
  }

  loadSprites(createImage: () => HTMLImageElement): void {
    for (const mode of Object.keys(PET_CHARACTER_SPRITES) as PetCharacterMode[]) {
      const spec = PET_CHARACTER_SPRITES[mode]
      const image = createImage()
      const sprite: LoadedPetCharacterSprite = { image, ready: false }
      this.sprites.set(mode, sprite)
      image.decoding = 'async'
      image.onload = () => {
        if (this.disposed) return
        sprite.ready = image.naturalWidth === spec.frameCount * 192 && image.naturalHeight === 192
        this.restart()
      }
      image.onerror = () => {
        if (this.disposed) return
        sprite.ready = false
        this.restart()
      }
      image.src = spec.source
    }
  }

  setMode(mode: Exclude<PetCharacterMode, 'dragging'>): void {
    if (this.mode === mode) return
    this.mode = mode
    this.restart()
  }

  setDragging(dragging: boolean): void {
    if (this.dragging === dragging) return
    this.dragging = dragging
    this.restart()
  }

  setReducedMotion(reducedMotion: boolean): void {
    if (this.reducedMotion === reducedMotion) return
    this.reducedMotion = reducedMotion
    this.restart()
  }

  setActive(active: boolean): void {
    if (this.active === active) return
    this.active = active
    this.restart()
  }

  dispose(): void {
    this.disposed = true
    this.active = false
    this.cancelFrame()
    for (const sprite of this.sprites.values()) {
      sprite.image.onload = null
      sprite.image.onerror = null
    }
    this.sprites.clear()
  }

  private readonly tick = (timestamp: number): void => {
    this.frameHandle = undefined
    this.draw(timestamp)
    if (!this.hasSettled(timestamp)) this.scheduleFrame()
  }

  private restart(): void {
    if (this.disposed) return
    this.startedAt = this.clock.now()
    this.lastFrameKey = undefined
    this.cancelFrame()
    this.draw(this.startedAt)
    this.scheduleFrame()
  }

  private draw(timestamp: number): void {
    const mode = this.dragging ? 'dragging' : this.mode
    const elapsedMs = timestamp - this.startedAt
    const sprite = this.sprites.get(mode)
    if (sprite?.ready === true) {
      const frame = petCharacterSpriteFrame(mode, elapsedMs, this.reducedMotion)
      const frameKey = 'sprite:' + mode + ':' + String(frame)
      if (frameKey === this.lastFrameKey) return
      this.lastFrameKey = frameKey
      drawPetCharacterSprite(this.canvas, sprite.image, frame)
      return
    }
    const pose = petCharacterPose(mode, elapsedMs, this.reducedMotion)
    const frameKey = 'fallback:' + pose.mode + ':' + String(pose.frame)
    if (frameKey === this.lastFrameKey) return
    this.lastFrameKey = frameKey
    drawPetCharacter(this.canvas, pose)
  }

  private hasSettled(timestamp: number): boolean {
    const mode = this.dragging ? 'dragging' : this.mode
    if (mode !== 'success' && mode !== 'error') return false
    const sprite = this.sprites.get(mode)
    const frameCount = sprite?.ready === true ? PET_CHARACTER_SPRITES[mode].frameCount : FRAME_COUNTS[mode]
    const frameMs = sprite?.ready === true ? PET_CHARACTER_SPRITES[mode].frameMs : FRAME_MS[mode]
    return timestamp - this.startedAt >= frameCount * frameMs
  }

  private scheduleFrame(): void {
    if (!this.active || this.reducedMotion || this.frameHandle !== undefined) return
    this.frameHandle = this.clock.requestFrame(this.tick)
  }

  private cancelFrame(): void {
    if (this.frameHandle === undefined) return
    this.clock.cancelFrame(this.frameHandle)
    this.frameHandle = undefined
  }
}

export function createPetCharacter(canvas: HTMLCanvasElement): PetCharacterAnimator {
  const animator = new PetCharacterAnimator(canvas, {
    now: () => performance.now(),
    requestFrame: callback => requestAnimationFrame(callback),
    cancelFrame: handle => { cancelAnimationFrame(handle) },
  })
  animator.loadSprites(() => new Image())
  return animator
}
