import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../assets/koi-pond.js', import.meta.url), 'utf8')
const logic = source.slice(source.indexOf('  function mapWmoToWeather('), source.indexOf('  function updateWeatherUI('))

interface TestContext {
  mapWmoToWeather: (code: number, rain?: number, snowfall?: number) => string
  mapQWeatherToWeather: (icon: string, text?: string, precip?: number) => string
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

  it('ships nighttime snowy pond backdrop asset with valid webp format', () => {
    const filename = 'koi-pond-snow-night.webp'
    const image = readFileSync(new URL(`../assets/${filename}`, import.meta.url))
    expect(image.toString('ascii', 0, 4)).toBe('RIFF')
    expect(image.toString('ascii', 8, 12)).toBe('WEBP')
    expect(image.byteLength).toBeGreaterThan(100_000)
  })

  it('ships nighttime rainy pond backdrop asset with valid webp format', () => {
    const filename = 'koi-pond-rain-night.webp'
    const image = readFileSync(new URL(`../assets/${filename}`, import.meta.url))
    expect(image.toString('ascii', 0, 4)).toBe('RIFF')
    expect(image.toString('ascii', 8, 12)).toBe('WEBP')
    expect(image.byteLength).toBeGreaterThan(100_000)
  })

  it('ships daytime snowy pond backdrop asset with valid webp format', () => {
    const filename = 'koi-pond-snow-day.webp'
    const image = readFileSync(new URL(`../assets/${filename}`, import.meta.url))
    expect(image.toString('ascii', 0, 4)).toBe('RIFF')
    expect(image.toString('ascii', 8, 12)).toBe('WEBP')
    expect(image.byteLength).toBeGreaterThan(100_000)
  })

  it('ships daytime rainy pond backdrop asset with valid webp format', () => {
    const filename = 'koi-pond-rain-day.webp'
    const image = readFileSync(new URL(`../assets/${filename}`, import.meta.url))
    expect(image.toString('ascii', 0, 4)).toBe('RIFF')
    expect(image.toString('ascii', 8, 12)).toBe('WEBP')
    expect(image.byteLength).toBeGreaterThan(100_000)
  })

  it('ships daytime overcast pond backdrop asset with valid webp format', () => {
    const filename = 'koi-pond-overcast-day.webp'
    const image = readFileSync(new URL(`../assets/${filename}`, import.meta.url))
    expect(image.toString('ascii', 0, 4)).toBe('RIFF')
    expect(image.toString('ascii', 8, 12)).toBe('WEBP')
    expect(image.byteLength).toBeGreaterThan(100_000)
  })

  it('declares weather selector and preload links in HTML', () => {
    const html = readFileSync(new URL('../assets/koi-pond.html', import.meta.url), 'utf8')
    expect(html).toContain('id="weather-select"')
    expect(html).toContain('id="weather-name"')
    expect(html).toContain('koi-weather-snow.webp')
    expect(html).toContain('koi-pond-overcast-day.webp')
    expect(html).toContain('koi-pond-rain-day.webp')
    expect(html).toContain('koi-pond-rain-night.webp')
    expect(html).toContain('koi-pond-snow-day.webp')
    expect(html).toContain('koi-pond-snow-night.webp')
  })

  it('maps QWeather codes, text, and precip to 8 distinct weather states', () => {
    const p = {} as TestContext
    runInNewContext(logic, p)
    const map = p.mapQWeatherToWeather

    // Clear sky
    expect(map('100', '晴')).toBe('clear')
    expect(map('150', '晴间少云')).toBe('overcast') // contains '云'
    expect(map('150', '晴')).toBe('clear')

    // Overcast / Cloudy / Fog / Haze
    expect(map('101', '多云')).toBe('overcast')
    expect(map('104', '阴')).toBe('overcast')
    expect(map('501', '雾')).toBe('overcast')
    expect(map('502', '霾')).toBe('overcast')

    // Drizzle (light rain / shower)
    expect(map('300', '阵雨')).toBe('drizzle')
    expect(map('305', '小雨')).toBe('drizzle')
    expect(map('309', '细雨')).toBe('drizzle')
    expect(map('0', '', 0.8)).toBe('drizzle')

    // Rain (moderate rain)
    expect(map('306', '中雨')).toBe('rain')
    expect(map('314', '小到中雨')).toBe('rain')
    expect(map('0', '', 2.5)).toBe('rain')

    // Storm (heavy rain / storm / thunderstorm)
    expect(map('302', '雷阵雨')).toBe('storm')
    expect(map('307', '大雨')).toBe('storm')
    expect(map('310', '暴雨')).toBe('storm')
    expect(map('311', '大暴雨')).toBe('storm')
    expect(map('0', '', 8.0)).toBe('storm')

    // Snow states
    expect(map('400', '小雪')).toBe('light_snow')
    expect(map('404', '雨夹雪')).toBe('light_snow')
    expect(map('401', '中雪')).toBe('snow')
    expect(map('402', '大雪')).toBe('heavy_snow')
    expect(map('403', '暴雪')).toBe('heavy_snow')
  })

  it('provides configurable QWeather modal controls in UI without hardcoded personal keys', () => {
    // Ensure no personal credentials or domains are hardcoded in source
    expect(source).not.toContain('2a029b0ff19c4fecb067635f8ef2fe85')
    expect(source).not.toContain('nt3qquge4t')

    const html = readFileSync(new URL('../assets/koi-pond.html', import.meta.url), 'utf8')
    expect(html).not.toContain('2a029b0ff19c4fecb067635f8ef2fe85')
    expect(html).not.toContain('nt3qquge4t')
    expect(html).toContain('id="weather-config-btn"')
    expect(html).toContain('id="weather-config-modal"')
    expect(html).toContain('id="cfg-weather-host"')
    expect(html).toContain('id="cfg-weather-key"')
    expect(html).toContain('id="cfg-weather-reset"')
    expect(html).toContain('id="cfg-weather-save"')
    expect(html).toContain('实时天气 (和风天气)')
  })
})
