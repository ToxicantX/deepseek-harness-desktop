import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'

const source = readFileSync(new URL('../assets/koi-pond.js', import.meta.url), 'utf8')
const logic = source.slice(source.indexOf('  function visualBudget('), source.indexOf('  function hashId('))
  + source.slice(source.indexOf('  function makeAmbientPoints('), source.indexOf('  function makeBackdrop('))

it('bounds ambient decoration count and refresh rate for normal and reduced motion', () => {
  const p = {
    reduced: false, ambientPoints: [], sceneFrame: { x: 0, y: 0, width: 1280, height: 720 },
    random: (min, max) => (min + max) / 2, waterDistance: () => 0,
  }
  runInNewContext(logic, p)
  expect(p.visualBudget(false)).toEqual({ points: 18, refresh: 100 })
  expect(p.visualBudget(true)).toEqual({ points: 8, refresh: Infinity })
  p.makeAmbientPoints()
  expect(p.ambientPoints).toHaveLength(18)
  p.reduced = true; p.makeAmbientPoints()
  expect(p.ambientPoints).toHaveLength(8)
  expect(p.seasonParticleCount('spring', false)).toBe(8)
  expect(p.seasonParticleCount('summer', false)).toBe(7)
  expect(p.seasonParticleCount('autumn', false)).toBe(9)
  expect(p.seasonParticleCount('winter', false)).toBe(2)
  expect(p.seasonParticleCount('autumn', true)).toBe(4)
  expect(p.seasonParticleCount('winter', true)).toBe(1)
})

it('ships the generated autumn leaf and winter mist as bounded local WebP assets', () => {
  const html = readFileSync(new URL('../assets/koi-pond.html', import.meta.url), 'utf8')
  for (const name of ['autumn-leaf', 'winter-mist']) {
    const filename = `koi-season-${name}.webp`
    const image = readFileSync(new URL(`../assets/${filename}`, import.meta.url))
    expect(image.toString('ascii', 0, 4)).toBe('RIFF')
    expect(image.toString('ascii', 8, 12)).toBe('WEBP')
    expect(image.byteLength).toBeLessThan(80_000)
    expect(html).toContain(`href="${filename}"`)
    expect(source).toContain(`'${filename}'`)
  }
  expect(source).toContain('spring: eventImages.petals')
  expect(source).toContain('summer: eventImages.fireflies')
  expect(html).toContain('id="season-name"')
})

it('ships the generated washi material and consumes it only as a UI texture', () => {
  const image = readFileSync(new URL('../assets/koi-pond-washi.webp', import.meta.url))
  const css = readFileSync(new URL('../assets/koi-pond.css', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../assets/koi-pond.html', import.meta.url), 'utf8')
  expect(image.toString('ascii', 0, 4)).toBe('RIFF')
  expect(image.toString('ascii', 8, 12)).toBe('WEBP')
  expect(image.byteLength).toBeLessThan(50_000)
  expect(css.match(/koi-pond-washi\.webp/g)).toHaveLength(3)
  expect(html).toContain('id="period-name"')
  expect(html).toContain('id="clock"')
})

it('keeps the time selector popup readable on Windows', () => {
  const css = readFileSync(new URL('../assets/koi-pond.css', import.meta.url), 'utf8')
  expect(css).toContain('#light option { background: #07332f; color: #f0efcf; }')
  expect(css).toContain('#light option:checked { background: #d8c584; color: #062521; }')
})
