import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'

const source = readFileSync(new URL('../assets/koi-pond.js', import.meta.url), 'utf8')
const logic = source.slice(source.indexOf('  const patterns ='), source.indexOf('  let state,'))
  + source.slice(source.indexOf('  function hashId('), source.indexOf('  function notify('))
function pond(saved = null) {
  const storage = new Map(saved ? [['koi-pond-bonds', JSON.stringify(saved)]] : [])
  const p = {
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    document: { querySelectorAll: () => [] }, selected: undefined,
    bonds: saved || { dialogues: null, fish: {} },
    clamp: (v, min, max) => Math.max(min, Math.min(max, v)), $: () => ({ textContent: '' }),
  }
  runInNewContext(logic, p)
  return { p, storage }
}
const fish = (pattern, generation = 1, id = pattern) => ({ id, pattern, generation })

it('gives the original four koi stable and distinct personalities', () => {
  const { p } = pond()
  expect(['kohaku', 'sanke', 'ogon', 'shusui'].map(pattern => p.personalityFor(fish(pattern)).name))
    .toEqual(['好奇', '胆小', '贪吃', '安静'])
  expect(p.personalityFor(fish('kohaku')).description).toContain('指针')
})

it('assigns descendants deterministically and keeps affinity between zero and one hundred', () => {
  const { p } = pond({ dialogues: 7, fish: { child: 99, broken: 500 } })
  const child = fish('kohaku', 2, 'child')
  expect(p.personalityFor(child)).toEqual(p.personalityFor(fish('ogon', 2, 'child')))
  expect(p.affinityOf(child)).toBe(99)
  p.addAffinity(child, 10)
  expect(p.affinityOf(child)).toBe(100)
  expect(p.bondTitle(100)).toBe('形影相随')
})

it('writes relationship progress separately from the pond save', () => {
  const { p, storage } = pond()
  const koi = fish('kohaku')
  p.addAffinity(koi, 2)
  expect(JSON.parse(storage.get('koi-pond-bonds')).fish.kohaku).toBe(2)
})
