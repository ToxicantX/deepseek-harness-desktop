import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'

const source = readFileSync(new URL('../assets/koi-pond.js', import.meta.url), 'utf8')
const geometry = source.slice(source.indexOf('  const shoreline ='), source.indexOf('  function makeBackdrop('))
function pond(frame = { x: 0, y: 0, width: 1280, height: 673 }) {
  const p = { sceneFrame: frame, clamp: (v, min, max) => Math.max(min, Math.min(max, v)) }
  runInNewContext(geometry, p)
  return p
}
it('includes the expanded top, left, right and bottom water', () => {
  const p = pond()
  for (const [x, y] of [[600,60],[290,240],[300,445],[1020,390],[735,643],[640,350]]) {
    expect(p.waterDistance(x, y), `${x},${y}`).toBe(0)
  }
})
it('excludes shore and the lotus inlets', () => {
  const p = pond()
  for (const [x, y] of [[150,300],[450,150],[780,130],[320,340],[850,580],[1100,400]]) {
    expect(p.waterDistance(x, y), `${x},${y}`).toBe(2)
  }
})
it('maps the boundary with background scaling and cropping and refreshes cache', () => {
  const p = pond()
  p.waterOutline()
  p.sceneFrame = { x: -100, y: 20, width: 640, height: 336.5 }
  expect(p.waterDistance(200,50)).toBe(0)
  expect(p.waterDistance(-25,170)).toBe(2)
})
it('projects an out-of-water fish to the nearest shoreline, not the old ellipse', () => {
  const p = pond()
  expect(p.keepInWater(640,350)).toEqual({ x: 640, y: 350 })
  const edge = p.keepInWater(1100,400)
  expect(edge.x).toBeGreaterThan(1050)
  expect(edge.x).toBeLessThan(1060)
  expect(edge.y).toBeGreaterThan(390)
})
