import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PET_CHARACTER_SPRITES, type PetCharacterMode } from '../src/pet-character.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const modes = Object.keys(PET_CHARACTER_SPRITES) as PetCharacterMode[]
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

describe('packaged anime pet sprite assets', () => {
  it.each(modes)('ships a lossless RGBA %s strip with exact frame geometry', mode => {
    const spec = PET_CHARACTER_SPRITES[mode]
    const runtime = readFileSync(join(root, 'assets', spec.source))
    const source = readFileSync(join(root, 'assets', 'pet-character', 'source', mode + '.png'))
    expect(runtime.subarray(0, 8)).toEqual(pngSignature)
    expect(runtime.readUInt32BE(16)).toBe(spec.frameCount * 192)
    expect(runtime.readUInt32BE(20)).toBe(192)
    expect(runtime[25]).toBe(6)
    expect(hash(runtime)).toBe(hash(source))
  })

  it('packages runtime strips without including source artwork', () => {
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { build: { files: string[] } }
    expect(packageJson.build.files).toContain('assets/pet-character/runtime/*.png')
    expect(packageJson.build.files.some(pattern => pattern.includes('pet-character/source'))).toBe(false)
  })
})
