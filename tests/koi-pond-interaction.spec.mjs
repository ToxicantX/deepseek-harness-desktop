import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../assets/koi-pond.js', import.meta.url), 'utf8')
const interact = source.slice(source.indexOf('  function interact('), source.indexOf('  function refractWater('))
function pond() {
  const context = {
    state: {}, mode: 'ripple', ripples: [], food: [], lastInteraction: -Infinity,
    fish: [], selected: undefined, feedBatch: 0,
    width: 1280, height: 720, now: 0,
    window: { koiWater: { duration: 2.5 } },
    waterDistance: () => 0, random: () => 0,
    clamp: (v, min, max) => Math.max(min, Math.min(max, v)),
    personalityFor: () => ({ key: 'calm' }), keepInWater: (x, y) => ({ x, y }), addAffinity: () => {},
    notify: () => { throw new Error('Rejected clicks must not refresh notices') },
  }
  context.performance = { now: () => context.now }
  runInNewContext(interact, context)
  return context
}

describe('pond interaction budget', () => {
  it('accepts the first click and drops rapid input without queuing', () => {
    const p = pond()
    for (let i = 0; i < 1000; i++) p.interact(610, 400)
    expect(p.ripples).toHaveLength(1)
    p.now = 499
    p.interact(610, 400)
    expect(p.ripples).toHaveLength(1)
    p.now = 500
    p.interact(610, 400)
    expect(p.ripples).toHaveLength(2)
  })

  it('caps active refraction waves at three and resumes after expiry', () => {
    const p = pond()
    for (let i = 0; i < 10; i++) {
      p.now = i * 500
      p.interact(610, 400)
    }
    expect(p.ripples).toHaveLength(3)
    p.ripples[0].age = 2.5
    p.interact(610, 400)
    expect(p.ripples.filter(r => r.age < 2.5)).toHaveLength(3)
  })

  it('shares cooldown across modes and rejects feeding before creating effects', () => {
    const p = pond()
    p.interact(610, 400)
    p.mode = 'feed'
    p.interact(610, 400)
    expect(p.food).toHaveLength(0)
    p.now = 500
    p.interact(610, 400)
    expect(p.food).toHaveLength(5)
    expect(p.ripples).toHaveLength(2)
    p.food = Array(45).fill({})
    p.now = 1000
    p.interact(610, 400)
    expect(p.food).toHaveLength(45)
    expect(p.ripples).toHaveLength(2)
  })

  it('does not consume cooldown outside water or before state loads', () => {
    const p = pond()
    p.state = null
    p.interact(610, 400)
    p.state = {}
    p.waterDistance = () => 2
    p.interact(610, 400)
    expect(p.lastInteraction).toBe(-Infinity)
    p.waterDistance = () => 0
    p.interact(610, 400)
    expect(p.ripples).toHaveLength(1)
  })

  it('counts feeding waves in the shared cap across mode switches', () => {
    const p = pond()
    p.mode = 'feed'
    for (let i = 0; i < 3; i++) {
      p.now = i * 500
      p.interact(610, 400)
    }
    expect(p.food).toHaveLength(15)
    expect(p.ripples.every(r => !r.strong)).toBe(true)
    p.now = 1500
    p.interact(610, 400)
    expect(p.food).toHaveLength(15)
    p.mode = 'ripple'
    p.interact(610, 400)
    expect(p.ripples).toHaveLength(3)
  })

  it('makes timid koi flee, curious koi inspect and the selected nearby koi bond', () => {
    const p = pond(), gained = []
    p.fish = [
      { id: 'timid', key: 'timid', x: 600, y: 400 },
      { id: 'curious', key: 'curious', x: 620, y: 400 },
    ]
    p.selected = 'curious'
    p.personalityFor = fish => ({ key: fish.key })
    p.addAffinity = (fish, amount) => gained.push([fish.id, amount])
    p.interact(610, 400)
    expect(p.fish[0].target.x).toBeLessThan(600)
    expect(p.fish[0].startledUntil).toBe(1800)
    expect(p.fish[1].target).toEqual({ x: 610, y: 400 })
    expect(gained).toEqual([['curious', 1]])
  })
})
