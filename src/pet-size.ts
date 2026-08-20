export const PET_SIZES = ['small', 'standard', 'large'] as const
export type PetSize = (typeof PET_SIZES)[number]

export interface PetSizeSpec {
  mascotSize: number
  mascotX: number
  mascotY: number
  windowWidth: number
  windowHeight: number
}

export const DEFAULT_PET_SIZE: PetSize = 'standard'

export const PET_SIZE_SPECS: Readonly<Record<PetSize, PetSizeSpec>> = {
  small: { mascotSize: 72, mascotX: 256, mascotY: 136, windowWidth: 336, windowHeight: 216 },
  standard: { mascotSize: 96, mascotX: 256, mascotY: 136, windowWidth: 360, windowHeight: 240 },
  large: { mascotSize: 128, mascotX: 256, mascotY: 136, windowWidth: 392, windowHeight: 272 },
}

export function parsePetSize(value: unknown): PetSize {
  return value === 'small' || value === 'large' ? value : DEFAULT_PET_SIZE
}
