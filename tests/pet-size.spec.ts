import { describe, expect, it } from 'vitest'
import { DEFAULT_PET_SIZE, PET_SIZES, PET_SIZE_SPECS, parsePetSize } from '../src/pet-size.ts'

describe('desktop pet size contract', () => {
  it('keeps the released 96px geometry as the standard default', () => {
    expect(DEFAULT_PET_SIZE).toBe('standard')
    expect(PET_SIZE_SPECS.standard).toEqual({
      mascotSize: 96, mascotX: 256, mascotY: 136, windowWidth: 360, windowHeight: 240,
    })
  })

  it('provides stable small, standard, and large native geometry', () => {
    expect(PET_SIZES).toEqual(['small', 'standard', 'large'])
    expect(PET_SIZE_SPECS.small).toEqual({
      mascotSize: 72, mascotX: 256, mascotY: 136, windowWidth: 336, windowHeight: 216,
    })
    expect(PET_SIZE_SPECS.large).toEqual({
      mascotSize: 128, mascotX: 256, mascotY: 136, windowWidth: 392, windowHeight: 272,
    })
  })

  it.each([undefined, null, 'medium', 96, {}, []])('falls back invalid persisted size %j to standard', value => {
    expect(parsePetSize(value)).toBe('standard')
  })
})
