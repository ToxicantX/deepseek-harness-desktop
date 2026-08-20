import { describe, expect, it, vi } from 'vitest'
import { PET_CHARACTER_SPRITES, PetCharacterAnimator, petCharacterPose, petCharacterSpriteFrame, type PetCharacterMode } from '../src/pet-character.ts'

const modes: PetCharacterMode[] = ['idle', 'thinking', 'speaking', 'approval', 'success', 'error', 'unavailable', 'dragging']

function recordingCanvas(): { canvas: HTMLCanvasElement; method(name: string): ReturnType<typeof vi.fn> } {
  const methods = new Map<PropertyKey, ReturnType<typeof vi.fn>>()
  const context = new Proxy<Record<PropertyKey, unknown>>({}, {
    get(target, property) {
      if (property in target) return target[property]
      const method = methods.get(property) ?? vi.fn()
      methods.set(property, method)
      return method
    },
    set(target, property, value) { target[property] = value; return true },
  })
  return {
    canvas: { width: 192, height: 192, getContext: vi.fn(() => context) } as unknown as HTMLCanvasElement,
    method: name => methods.get(name) ?? vi.fn(),
  }
}

function fakeCanvas(): HTMLCanvasElement {
  const methods = new Map<PropertyKey, ReturnType<typeof vi.fn>>()
  const context = new Proxy<Record<PropertyKey, unknown>>({}, {
    get(target, property) {
      if (property in target) return target[property]
      const method = methods.get(property) ?? vi.fn()
      methods.set(property, method)
      return method
    },
    set(target, property, value) { target[property] = value; return true },
  })
  return { width: 192, height: 192, getContext: vi.fn(() => context) } as unknown as HTMLCanvasElement
}

describe('original desktop pet character', () => {
  it('defines a distinct animated pose and status color for every runtime state', () => {
    const poses = modes.map(mode => petCharacterPose(mode, 0))
    expect(new Set(poses.map(pose => pose.statusColor)).size).toBe(modes.length)
    expect(poses.map(pose => pose.mode)).toEqual(modes)
    expect(petCharacterPose('thinking', 260).frame).not.toBe(petCharacterPose('thinking', 0).frame)
    expect(petCharacterPose('speaking', 110).mouth).not.toBe(petCharacterPose('speaking', 0).mouth)
    expect(petCharacterPose('approval', 100).offsetX).not.toBe(petCharacterPose('approval', 0).offsetX)
    expect(petCharacterPose('success', 180).offsetY).toBeLessThan(petCharacterPose('success', 0).offsetY)
    expect(petCharacterPose('error', 90).offsetX).not.toBe(petCharacterPose('error', 0).offsetX)
    expect(petCharacterPose('success', 60_000).frame).toBe(7)
    expect(petCharacterPose('error', 60_000).frame).toBe(5)
  })

  it('maps every local sprite strip to bounded loop or one-shot frames', () => {
    expect(Object.keys(PET_CHARACTER_SPRITES)).toEqual(modes)
    for (const mode of modes) {
      const spec = PET_CHARACTER_SPRITES[mode]
      expect(spec.source).toBe('pet-character/runtime/' + mode + '.png')
      expect(petCharacterSpriteFrame(mode, 0)).toBe(0)
      expect(petCharacterSpriteFrame(mode, 60_000, true)).toBe(spec.reducedMotionFrame)
      expect(spec.reducedMotionFrame).toBeLessThan(spec.frameCount)
    }
    expect(petCharacterSpriteFrame('idle', PET_CHARACTER_SPRITES.idle.frameMs * 8)).toBe(0)
    expect(petCharacterSpriteFrame('dragging', PET_CHARACTER_SPRITES.dragging.frameMs * 4)).toBe(0)
    expect(petCharacterSpriteFrame('success', 60_000)).toBe(7)
    expect(petCharacterSpriteFrame('error', 60_000)).toBe(5)
  })

  it.each(modes)('holds %s on one representative frame for reduced motion', mode => {
    expect(petCharacterPose(mode, 0, true)).toEqual(petCharacterPose(mode, 60_000, true))
  })

  it('loads only exact local strips and retains the procedural fallback for malformed geometry', () => {
    const recorded = recordingCanvas()
    const clock = { now: () => 0, requestFrame: vi.fn(() => 7), cancelFrame: vi.fn() }
    const animator = new PetCharacterAnimator(recorded.canvas, clock)
    const images: Array<HTMLImageElement & { naturalWidth: number; naturalHeight: number }> = []
    animator.loadSprites(() => {
      const image = { decoding: 'auto', src: '', naturalWidth: 0, naturalHeight: 0, onload: null, onerror: null }
      images.push(image as unknown as HTMLImageElement & { naturalWidth: number; naturalHeight: number })
      return image as unknown as HTMLImageElement
    })
    expect(images.map(image => image.src)).toEqual(modes.map(mode => PET_CHARACTER_SPRITES[mode].source))

    const idle = images.find(image => image.src.endsWith('/idle.png'))
    if (idle === undefined) throw new Error('idle sprite was not requested')
    idle.naturalWidth = 1_536
    idle.naturalHeight = 192
    ;(idle.onload as (() => void) | null)?.()
    expect(recorded.method('drawImage')).toHaveBeenCalledWith(idle, 0, 0, 192, 192, 0, 0, 192, 192)

    animator.setMode('thinking')
    const thinking = images.find(image => image.src.endsWith('/thinking.png'))
    if (thinking === undefined) throw new Error('thinking sprite was not requested')
    thinking.naturalWidth = 1
    thinking.naturalHeight = 1
    ;(thinking.onload as (() => void) | null)?.()
    expect(recorded.method('drawImage')).toHaveBeenCalledTimes(1)
    animator.dispose()
    expect(images.every(image => image.onload === null && image.onerror === null)).toBe(true)
  })

  it('schedules only while active and animated, then cancels cleanly', () => {
    let now = 0
    let pending: FrameRequestCallback | undefined
    const clock = {
      now: vi.fn(() => now),
      requestFrame: vi.fn((callback: FrameRequestCallback) => { pending = callback; return 7 }),
      cancelFrame: vi.fn(),
    }
    const animator = new PetCharacterAnimator(fakeCanvas(), clock)
    expect(clock.requestFrame).not.toHaveBeenCalled()

    animator.setActive(true)
    expect(clock.requestFrame).toHaveBeenCalledOnce()
    now = 130
    const callback = pending
    if (callback === undefined) throw new Error('animation frame was not scheduled')
    callback(now)
    expect(clock.requestFrame).toHaveBeenCalledTimes(2)

    animator.setReducedMotion(true)
    expect(clock.cancelFrame).toHaveBeenCalledWith(7)
    const requests = clock.requestFrame.mock.calls.length
    animator.setMode('approval')
    animator.setDragging(true)
    expect(clock.requestFrame).toHaveBeenCalledTimes(requests)

    animator.dispose()
    animator.setActive(false)
    expect(clock.requestFrame).toHaveBeenCalledTimes(requests)
  })
})
