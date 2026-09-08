import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const browser = {}
runInNewContext(readFileSync(new URL('../assets/koi-pond-refraction.js', import.meta.url), 'utf8'), { window: browser })
const { waveAt, sampleBilinear, refract } = browser.koiWater

function texture(width = 160, height = 160) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4
    data.set([x % 256, y % 256, (x * 13 + y * 7) % 256, 255], i)
  }
  return { width, height, data }
}
const amplitude = age => Math.abs(waveAt(74 * age - 27, age)[0])

describe('pond sine-wave refraction', () => {
  it('uses a travelling sine wave, zero outside the packet and at expiry', () => {
    expect(waveAt(30, 0)).toEqual([0, 0])
    expect(waveAt(80, 1)).toEqual([0, 0])
    expect(waveAt(0, 1)).toEqual([0, 0])
    expect(waveAt(100, 2.5)).toEqual([0, 0])
    expect(waveAt(74 - 5, 1)[0]).toBeGreaterThan(0)
    expect(waveAt(74 - 16, 1)[0]).toBeLessThan(0)
    expect(amplitude(.7)).toBeGreaterThan(amplitude(1.2))
    expect(amplitude(1.2)).toBeGreaterThan(amplitude(2.2))
  })

  it('interpolates the four adjacent pixels instead of rounding the sampling position', () => {
    const source = { width: 2, height: 2, data: new Uint8ClampedArray([
      0, 0, 0, 255, 100, 0, 40, 255,
      0, 100, 80, 255, 100, 100, 120, 255,
    ]) }
    const out = new Uint8ClampedArray(4)
    sampleBilinear(source, .25, .75, out, 0)
    expect([...out]).toEqual([25, 75, 70, 255])
    sampleBilinear(source, -10, 10, out, 0)
    expect([...out]).toEqual([0, 100, 80, 255])
  })

  it('distorts pixels only inside the expanding packet without modifying its source', () => {
    const source = texture(), original = source.data.slice()
    const output = refract(source, [{ x: 80, y: 80, age: .7 }])
    expect(source.data).toEqual(original)
    expect(output[3]).toBe(0)
    expect(output[(80 * 160 + 80) * 4 + 3]).toBe(0)
    let changed = 0
    for (let i = 0; i < output.length; i += 4) {
      if (output[i + 3] && (output[i] !== original[i] || output[i + 1] !== original[i + 1])) changed++
    }
    expect(changed).toBeGreaterThan(500)
    expect(refract(source, [{ x: 80, y: 80, age: 2.5 }]).some(v => v !== 0)).toBe(false)
  })

  it('combines simultaneous waves before sampling, independent of order', () => {
    const source = texture()
    const a = { x: 70, y: 80, age: .8 }, b = { x: 95, y: 80, age: .65 }
    const combined = refract(source, [a, b])
    expect(combined).toEqual(refract(source, [b, a]))
    expect(combined).not.toEqual(refract(source, [a]))
    expect(combined).not.toEqual(refract(source, [b]))
  })

  it('supports edge clicks and reduced amplitude without out-of-bounds artifacts', () => {
    const source = texture(32, 24)
    const output = refract(source, [{ x: 0, y: 0, age: .3, strength: .4 }])
    expect(output.length).toBe(source.data.length)
    for (let i = 3; i < output.length; i += 4) expect([0, 255]).toContain(output[i])
    expect(refract(source, [{ x: 0, y: 0, age: .3, strength: 0 }]).every(v => v === 0)).toBe(true)
  })

  it('loads the local refraction kernel before the garden script', () => {
    const html = readFileSync(new URL('../assets/koi-pond.html', import.meta.url), 'utf8')
    expect(html.indexOf('src="koi-pond-refraction.js"')).toBeGreaterThan(0)
    expect(html.indexOf('src="koi-pond-refraction.js"')).toBeLessThan(html.indexOf('src="koi-pond.js"'))
  })
})
