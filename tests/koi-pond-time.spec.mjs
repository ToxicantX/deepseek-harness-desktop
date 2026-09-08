import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'

const source = readFileSync(new URL('../assets/koi-pond.js', import.meta.url), 'utf8')
const logic = source.slice(source.indexOf('  function periodAt('), source.indexOf('  function makeBackdrop('))
it('uses local hours with exact morning, day, dusk and overnight boundaries', () => {
  const p = {}
  runInNewContext(logic, p)
  for (const [hour, expected] of [[0,'night'],[4.999,'night'],[5,'dawn'],[7.999,'dawn'],[8,'day'],[16.999,'day'],[17,'dusk'],[18.999,'dusk'],[19,'night'],[23.999,'night']]) {
    expect(p.periodAt(hour)).toBe(expected)
  }
})
it('refreshes on local minute changes, including clock moving backwards', () => {
  let hour = 16, minute = 59, builds = 0
  const button = { setAttribute() {}, removeAttribute() {} }
  const p = {
    clockMinute: -1, period: undefined, night: false, timeSetting: 'auto',
    Date: class { getHours() { return hour } getMinutes() { return minute } },
    document: { body: { dataset: {}, classList: { toggle() {} } } },
    $: () => button, makeBackdrop: () => builds++,
  }
  runInNewContext(logic, p)
  p.syncTime(); p.syncTime()
  expect(builds).toBe(1)
  expect(p.period).toBe('day')
  hour = 17; minute = 0; p.syncTime()
  expect(p.period).toBe('dusk')
  hour = 19; p.syncTime()
  expect(p.night).toBe(true)
  hour = 5; p.syncTime()
  expect(p.period).toBe('dawn')
  expect(p.night).toBe(false)
  expect(button.value).toBe('auto')
  expect(p.document.body.dataset.period).toBe('dawn')
  for (const manual of ['dawn', 'day', 'dusk', 'night']) {
    p.timeSetting = manual; p.clockMinute = -1
    p.syncTime()
    expect(p.period).toBe(manual)
    hour = 12; minute = 30
    const previousBuilds = builds
    p.syncTime()
    expect(p.period).toBe(manual)
    expect(builds).toBe(previousBuilds)
  }
  p.timeSetting = 'auto'; p.clockMinute = -1
  p.syncTime()
  expect(p.period).toBe('day')
})
