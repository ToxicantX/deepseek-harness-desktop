import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../assets/koi-pond.js', import.meta.url), 'utf8')
const logic = source.slice(source.indexOf('  function mapWmoToWeather('), source.indexOf('  function updateWeatherUI('))

interface TestContext {
  mapWmoToWeather: (code: number, rain?: number, snowfall?: number) => string
}

describe('koi pond weather system', () => {
  it('maps WMO codes and precipitation to 8 distinct weather states', () => {
    const p = {} as TestContext
    runInNewContext(logic, p)
    const map = p.mapWmoToWeather

    // Clear sky
    expect(map(0)).toBe('clear')
    // Overcast / Cloudy / Fog
    expect(map(1)).toBe('overcast')
    expect(map(2)).toBe('overcast')
    expect(map(3)).toBe('overcast')
    expect(map(45)).toBe('overcast')
    expect(map(48)).toBe('overcast')

    // Drizzle (light rain / drizzle codes or rain < 1.5mm)
    expect(map(51)).toBe('drizzle')
    expect(map(53)).toBe('drizzle')
    expect(map(55)).toBe('drizzle')
    expect(map(61)).toBe('drizzle')
    expect(map(0, 0.8)).toBe('drizzle')

    // Moderate rain (rain codes or 1.5 <= rain < 6mm)
    expect(map(63)).toBe('rain')
    expect(map(81)).toBe('rain')
    expect(map(0, 3.2)).toBe('rain')

    // Storm (heavy rain / thunderstorm or rain >= 6mm)
    expect(map(65)).toBe('storm')
    expect(map(82)).toBe('storm')
    expect(map(95)).toBe('storm')
    expect(map(99)).toBe('storm')
    expect(map(0, 8.0)).toBe('storm')

    // Snow states (snow codes or snowfall amount)
    expect(map(71)).toBe('light_snow')
    expect(map(0, 0, 0.3)).toBe('light_snow')
    expect(map(73)).toBe('snow')
    expect(map(0, 0, 1.0)).toBe('snow')
    expect(map(75)).toBe('heavy_snow')
    expect(map(86)).toBe('heavy_snow')
    expect(map(0, 0, 2.5)).toBe('heavy_snow')
  })

  it('ships generated snowflake assets with valid webp format', () => {
    const filename = 'koi-weather-snow.webp'
    const image = readFileSync(new URL(`../assets/${filename}`, import.meta.url))
    expect(image.toString('ascii', 0, 4)).toBe('RIFF')
    expect(image.toString('ascii', 8, 12)).toBe('WEBP')
    expect(image.byteLength).toBeLessThan(250_000)
  })

  it('declares weather selector and preload links in HTML', () => {
    const html = readFileSync(new URL('../assets/koi-pond.html', import.meta.url), 'utf8')
    expect(html).toContain('id="weather-select"')
    expect(html).toContain('id="weather-name"')
    expect(html).toContain('koi-weather-snow.webp')
  })
})
