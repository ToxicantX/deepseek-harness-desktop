import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'

const source = readFileSync(new URL('../assets/koi-pond.js', import.meta.url), 'utf8')
const selection = source.slice(source.indexOf('  const gardenEventPools ='), source.indexOf('  let state,'))
  + source.slice(source.indexOf('  function hashId('), source.indexOf('  function personalityFor('))

it('selects deterministic bounded events suited to each time period', () => {
  const p = {}
  runInNewContext(selection, p)
  const day = new Set(), night = new Set(); let empty = 0
  for (let dialogue = 1; dialogue <= 500; dialogue++) {
    const daylight = p.gardenEventFor(dialogue, 'day')
    const afterDark = p.gardenEventFor(dialogue, 'night')
    if (daylight) day.add(daylight); else empty++
    if (afterDark) night.add(afterDark)
  }
  expect([...day].sort()).toEqual(['dragonfly', 'frog', 'leap', 'petals'])
  expect([...night].sort()).toEqual(['fireflies', 'frog', 'leap', 'petals'])
  expect(empty).toBeGreaterThan(250)
  expect(p.gardenEventFor(3, 'day')).toBe('petals')
  expect(p.gardenEventFor(3, 'day')).toBe(p.gardenEventFor(3, 'day'))
  expect(p.gardenEventParticleCount('petals', false)).toBe(12)
  expect(p.gardenEventParticleCount('fireflies', false)).toBe(10)
  expect(p.gardenEventParticleCount('petals', true)).toBe(6)
  expect(p.gardenEventParticleCount('frog', false)).toBe(0)
})

it('draws every event path and clears it at expiry', () => {
  const rendering = source.slice(source.indexOf('  function eventProgress('), source.indexOf('  function periodAt('))
  let spriteDraws = 0
  const context = {
    clamp: (v, min, max) => Math.max(min, Math.min(max, v)), reduced: false,
    width: 1280,
    sceneFrame: { x: 0, y: 0, width: 1280, height: 720 },
    eventImages: Object.fromEntries(['petals', 'dragonfly', 'frog', 'fireflies', 'leap'].map(kind => [kind, { complete: true, naturalWidth: 128 }])),
    document: { body: { dataset: {} } }, ellipse() {},
    ctx: new Proxy({ drawImage: () => { spriteDraws++ } }, { get: (target, key) => target[key] || (() => {}), set: (target, key, value) => { target[key] = value; return true } }),
  }
  runInNewContext(rendering, context)
  for (const kind of ['petals', 'dragonfly', 'frog', 'fireflies', 'leap']) {
    const before = spriteDraws
    context.gardenEvent = { kind, started: 0, duration: 10, x: 500, y: 350, items: [{ x: 500, y: 350, phase: 1, size: 1, drift: 1 }] }
    context.document.body.dataset.event = kind
    expect(() => context.drawGardenEvent(1)).not.toThrow()
    expect(spriteDraws).toBeGreaterThan(before)
    context.drawGardenEvent(10)
    expect(context.gardenEvent).toBeUndefined()
    expect(context.document.body.dataset.event).toBeUndefined()
  }
})

it('animates fireflies randomly and gives every small creature visible motion', () => {
  const motionSource = source.slice(source.indexOf('  function dragonflyMotion('), source.indexOf('  function drawEventSprite('))
  const context = { sceneFrame: { x: 0, y: 0, width: 1280, height: 720 } }
  runInNewContext(motionSource, context)
  const dragonfly = { direction: -1, lane: .35, sway: .07, phase: .8, turns: .2 }
  const frog = { x: 300, y: 400, phase: .4, drift: -1, hopAt: .4 }
  const firefly = { x: 600, y: 350, phase: 1.1, speed: 1.05, arc: 36, drift: -.7, rise: 20 }
  const dragonflyStart = context.dragonflyMotion(dragonfly, 1, .1, false)
  const dragonflyEnd = context.dragonflyMotion(dragonfly, 4, .7, false)
  const frogGround = context.frogMotion(frog, 2, .3, false)
  const frogHop = context.frogMotion(frog, 3, .49, false)
  const fireflyStart = context.fireflyMotion(firefly, 1, .1, false)
  const fireflyEnd = context.fireflyMotion(firefly, 3, .5, false)
  expect(Math.hypot(dragonflyEnd.x - dragonflyStart.x, dragonflyEnd.y - dragonflyStart.y)).toBeGreaterThan(500)
  expect(frogHop.y).toBeLessThan(frogGround.y - 4)
  expect(Math.hypot(fireflyEnd.x - fireflyStart.x, fireflyEnd.y - fireflyStart.y)).toBeGreaterThan(20)
  expect(fireflyEnd.rotation).not.toBe(fireflyStart.rotation)
  const reducedStart = context.fireflyMotion(firefly, 1, .1, true)
  const reducedEnd = context.fireflyMotion(firefly, 3, .5, true)
  expect(Math.hypot(reducedEnd.x - reducedStart.x, reducedEnd.y - reducedStart.y))
    .toBeLessThan(Math.hypot(fireflyEnd.x - fireflyStart.x, fireflyEnd.y - fireflyStart.y))
})

it('ships and preloads the five generated transparent WebP event sprites', () => {
  const html = readFileSync(new URL('../assets/koi-pond.html', import.meta.url), 'utf8')
  const assets = ['petals', 'dragonfly', 'frog', 'firefly', 'splash']
  for (const name of assets) {
    const filename = `koi-event-${name}.webp`
    const image = readFileSync(new URL(`../assets/${filename}`, import.meta.url))
    expect(image.toString('ascii', 0, 4)).toBe('RIFF')
    expect(image.toString('ascii', 8, 12)).toBe('WEBP')
    expect(image.byteLength).toBeLessThan(120_000)
    expect(html).toContain(`href="${filename}"`)
    expect(source).toContain(`'${filename}'`)
  }
})
