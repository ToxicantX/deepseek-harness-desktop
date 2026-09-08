/* Local CPU refraction kernel. All coordinates are CSS pixels, time is seconds. */
(() => {
  'use strict'
  const SPEED = 74, PACKET = 72, WAVELENGTH = 22, DURATION = 2.5
  function waveAt(distance, age) {
    const behind = SPEED * age - distance
    if (age <= 0 || age >= DURATION || distance < 1 || behind <= 0 || behind >= PACKET) return [0, 0]
    // h(d,t) = A(d,t) sin(k(d-vt)); a smooth travelling packet avoids hard edges.
    const envelope = Math.sin(Math.PI * behind / PACKET) ** 2
    const amplitude = 16 * Math.exp(-age * .7) / (1 + distance * .006)
      * (1 - age / DURATION) * Math.min(1, distance / 10) * envelope
    const phase = behind * Math.PI * 2 / WAVELENGTH
    return [amplitude * Math.sin(phase), amplitude * Math.cos(phase) * Math.PI * 2 / WAVELENGTH]
  }

  function sampleBilinear(source, x, y, target, index, light = 1) {
    x = Math.max(0, Math.min(source.width - 1, x))
    y = Math.max(0, Math.min(source.height - 1, y))
    const x0 = Math.floor(x), y0 = Math.floor(y)
    const x1 = Math.min(x0 + 1, source.width - 1), y1 = Math.min(y0 + 1, source.height - 1)
    const fx = x - x0, fy = y - y0, data = source.data
    const a = (y0 * source.width + x0) * 4, b = (y0 * source.width + x1) * 4
    const c = (y1 * source.width + x0) * 4, d = (y1 * source.width + x1) * 4
    for (let channel = 0; channel < 4; channel++) {
      const top = data[a + channel] * (1 - fx) + data[b + channel] * fx
      const bottom = data[c + channel] * (1 - fx) + data[d + channel] * fx
      target[index + channel] = (top * (1 - fy) + bottom * fy) * (channel === 3 ? 1 : light)
    }
  }

  function refract(source, waves) {
    const { width, height } = source, count = width * height
    const output = new Uint8ClampedArray(count * 4)
    const dx = new Float32Array(count), dy = new Float32Array(count), shade = new Float32Array(count)
    const marked = new Uint8Array(count), touched = []
    for (const wave of waves) {
      const radius = Math.ceil(SPEED * wave.age), strength = wave.strength ?? 1
      // Evaluate trig once per radial sample, not once per pixel.
      const heights = new Float32Array(radius + 2), slopes = new Float32Array(radius + 2)
      for (let r = 0; r < heights.length; r++) {
        const sample = waveAt(r, wave.age)
        heights[r] = sample[0] * strength; slopes[r] = sample[1] * strength
      }
      const left = Math.max(0, Math.floor(wave.x - radius)), right = Math.min(width - 1, Math.ceil(wave.x + radius))
      const top = Math.max(0, Math.floor(wave.y - radius)), bottom = Math.min(height - 1, Math.ceil(wave.y + radius))
      for (let y = top; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
          const vx = x - wave.x, vy = y - wave.y, distance = Math.sqrt(vx * vx + vy * vy)
          if (distance < 1 || distance >= radius || distance <= radius - PACKET - 1) continue
          const r = Math.floor(distance), fraction = distance - r
          const displacement = heights[r] * (1 - fraction) + heights[r + 1] * fraction
          const slope = slopes[r] * (1 - fraction) + slopes[r + 1] * fraction
          if (Math.abs(displacement) + Math.abs(slope) < .001) continue
          const i = y * width + x, nx = vx / distance, ny = vy / distance
          dx[i] += displacement * nx; dy[i] += displacement * ny
          shade[i] += slope * (nx * -.4 + ny * -.6) * .1
          if (!marked[i]) { marked[i] = 1; touched.push(i) }
        }
      }
    }
    // Combine intersecting waves before sampling the unmodified frame once.
    for (const i of touched) {
      const light = 1 + Math.max(-.12, Math.min(.12, shade[i]))
      sampleBilinear(source, i % width + dx[i], Math.floor(i / width) + dy[i], output, i * 4, light)
    }
    return output
  }
  window.koiWater = { waveAt, sampleBilinear, refract, speed: SPEED, duration: DURATION }
})()
