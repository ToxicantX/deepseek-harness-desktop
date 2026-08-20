import { describe, expect, it } from 'vitest'
import { DEFAULT_PET_SKIN, isDefaultPetSkin, parsePetSkinSource, selectPetSkinUrl } from '../src/pet-skin.ts'

const png = 'data:image/png;base64,cG9zdGVy'
const gif = 'data:image/gif;base64,R0lGODlh'

describe('pet skin renderer payload', () => {
  it('restores the bundled icon for a null main-process skin', () => {
    const skin = parsePetSkinSource({ dataUrl: null, reducedMotionDataUrl: null })
    expect(skin).toEqual(DEFAULT_PET_SKIN)
    expect(isDefaultPetSkin(skin!)).toBe(true)
  })

  it('uses a static PNG for both normal and reduced-motion modes', () => {
    const skin = parsePetSkinSource({ dataUrl: png, reducedMotionDataUrl: null })
    expect(skin).toEqual({ kind: 'custom', dataUrl: png, reducedMotionDataUrl: png })
    expect(isDefaultPetSkin(skin!)).toBe(false)
    expect(selectPetSkinUrl(skin!, false)).toBe(png)
    expect(selectPetSkinUrl(skin!, true)).toBe(png)
  })

  it('selects the GIF normally and its PNG poster for reduced motion', () => {
    const skin = parsePetSkinSource({ dataUrl: gif, reducedMotionDataUrl: png })
    expect(selectPetSkinUrl(skin!, false)).toBe(gif)
    expect(selectPetSkinUrl(skin!, true)).toBe(png)
    expect(selectPetSkinUrl(skin!, false, false)).toBe(png)
  })

  it('falls back to the bundled icon when an animated payload lacks a valid poster', () => {
    expect(parsePetSkinSource({ dataUrl: gif, reducedMotionDataUrl: 'data:image/gif;base64,AAAA' })).toEqual({
      kind: 'custom',
      dataUrl: gif,
      reducedMotionDataUrl: 'icon.png',
    })
  })

  it.each([
    null,
    [],
    { dataUrl: 'https://example.com/pet.gif' },
    { dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' },
    { dataUrl: 'data:image/gif;base64,' },
    { dataUrl: 'data:image/gif;base64,not-base64!' },
    { dataUrl: 'data:image/gif;base64,' + 'A'.repeat(3_000_001) },
  ])('rejects untrusted or oversized skin payloads', value => {
    expect(parsePetSkinSource(value)).toBeUndefined()
  })
})
