const MAX_SKIN_DATA_URL_LENGTH = 3_000_000
const PNG_PREFIX = 'data:image/png;base64,'
const GIF_PREFIX = 'data:image/gif;base64,'

export interface PetSkinView {
  kind: 'builtin' | 'custom'
  dataUrl: string
  reducedMotionDataUrl: string
}

export const DEFAULT_PET_SKIN: PetSkinView = {
  kind: 'builtin',
  dataUrl: 'icon.png',
  reducedMotionDataUrl: 'icon.png',
}

function imageDataUrl(value: unknown, prefixes: readonly string[]): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_SKIN_DATA_URL_LENGTH) return undefined
  const prefix = prefixes.find(candidate => value.startsWith(candidate))
  if (prefix === undefined) return undefined
  const encoded = value.slice(prefix.length)
  if (encoded.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return undefined
  return value
}

export function parsePetSkinSource(value: unknown): PetSkinView | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (input.dataUrl === null) return DEFAULT_PET_SKIN
  const dataUrl = imageDataUrl(input.dataUrl, [PNG_PREFIX, GIF_PREFIX])
  if (dataUrl === undefined) return undefined
  const poster = imageDataUrl(input.reducedMotionDataUrl, [PNG_PREFIX])
  return {
    kind: 'custom',
    dataUrl,
    reducedMotionDataUrl: poster ?? (dataUrl.startsWith(PNG_PREFIX) ? dataUrl : DEFAULT_PET_SKIN.dataUrl),
  }
}

export function isDefaultPetSkin(skin: PetSkinView): boolean { return skin.kind === 'builtin' }

export function selectPetSkinUrl(skin: PetSkinView, reducedMotion: boolean, visible = true): string {
  return reducedMotion || !visible ? skin.reducedMotionDataUrl : skin.dataUrl
}
