/* Local canvas garden. No network, dependencies, or access to conversation content. */
(() => {
  'use strict'
  const $ = id => document.getElementById(id)
  const canvas = $('pond'), ctx = canvas.getContext('2d')
  const bridge = window.koiPond
  const patterns = { kohaku: ['红白', '#eee6ce', '#c44c32'], sanke: ['大正三色', '#e8e4d2', '#b74731'], ogon: ['黄金', '#e3bf63', '#ba8638'], shusui: ['秋翠', '#bacfd0', '#d77947'] }
  let state, selected, width = 0, height = 0, mode = 'feed', night = false, zen = false
  let fish = [], food = [], ripples = [], last = 0, frame = 0, noticeTimer, lastInteraction = -Infinity
  let keyboardPoint = { x: .4, y: .55 }, keyboardActive = false
  const backdrop = document.createElement('canvas')
  const sunlight = document.createElement('canvas')
  let period, clockMinute = -1, lastClockCheck = -Infinity
  let timeSetting = 'auto'
  try {
    const saved = localStorage.getItem('koi-pond-time-setting')
    if (['auto', 'dawn', 'day', 'dusk', 'night'].includes(saved)) timeSetting = saved
  } catch { /* Keep the default when local storage is unavailable. */ }
  const refractionCanvas = document.createElement('canvas')
  const refractionContext = refractionCanvas.getContext('2d', { willReadFrequently: true })
  const sceneImages = { day: new Image(), night: new Image() }
  let sceneFrame = { x: 0, y: 0, width: 1723, height: 913 }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const random = (min, max) => min + Math.random() * (max - min)
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v))
  function notify(text) {
    if (zen) return
    $('notice').textContent = text
    $('notice').classList.add('show')
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => $('notice').classList.remove('show'), 3500)
  }
  function stage(level) { return Math.min(10, Math.floor(level / 100)) }
  function size(f) { return (18 + stage(f.level) * 3) * clamp(width / 1280, .8, 1.35) }
  function update(next) {
    const previous = state
    state = next
    fish = next.fish.map((data, i) => {
      const existing = fish.find(f => f.id === data.id)
      return Object.assign(existing || {
        x: width * (.25 + i % 4 * .1), y: height * (.4 + Math.floor(i / 4) * .1),
        angle: random(0, Math.PI * 2), phase: random(0, 10), target: null,
      }, data)
    })
    if (previous && next.fish.length > previous.fish.length) notify('新生命抵达庭院，一条小锦鲤破壳了。')
    else if (previous && next.eggs.length > previous.eggs.length) notify('荷叶下藏着新期待：锦鲤产卵了。')
    else if (previous && next.dialogues > previous.dialogues) notify('又一段对话，池中锦鲤各长大 1 级。')
    $('count').textContent = `${fish.length} 尾 / 16`
    $('journey').textContent = `已陪你完成 ${next.dialogues} 次对话 · 每一次交流，都是成长。`
    $('fish-list').replaceChildren(...fish.map(f => {
      const card = document.createElement('button')
      card.className = 'fish-card'
      card.setAttribute('aria-pressed', String(selected === f.id))
      const mark = document.createElement('span')
      mark.className = 'fish-mark'
      mark.style.background = `linear-gradient(145deg,${patterns[f.pattern][1]} 35%,${patterns[f.pattern][2]} 36%,${patterns[f.pattern][2]} 65%,${patterns[f.pattern][1]} 66%)`
      const copy = document.createElement('span'), sub = document.createElement('small'), level = document.createElement('b')
      copy.className = 'fish-copy'
      copy.textContent = f.name
      sub.textContent = `${patterns[f.pattern][0]} · ${f.sex === 'female' ? '♀' : '♂'} · 第 ${f.generation} 代`
      copy.append(sub)
      level.textContent = `Lv.${f.level}`
      card.append(mark, copy, level)
      card.onclick = () => { selected = f.id; update(state) }
      return card
    }))
    const current = fish.find(f => f.id === selected)
    $('profile').hidden = !current
    if (current) {
      if (document.activeElement !== $('fish-name')) $('fish-name').value = current.name
      $('lineage').textContent = `第 ${stage(current.level) + 1} 阶形态 · ${current.bred ? '已孕育下一代' : current.level >= 500 ? '等待成熟伴侣' : `距成熟还有 ${500 - current.level} 级`}。${current.level < 1000 ? `再升 ${100 - current.level % 100} 级舒展鳍尾。` : '体型已完全舒展，等级继续记录陪伴。'}`
    }
    $('eggs').textContent = next.eggs.map(e => `◉ 鱼卵 · 再聊 ${e.remaining} 次孵化`).join('\n')
  }
  function ellipse(c, x, y, rx, ry, color, rotation = 0) {
    c.fillStyle = color
    c.beginPath(); c.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2); c.fill()
  }
  function waterPosition(angle, radius) {
    return {
      x: sceneFrame.x + sceneFrame.width * (.54 + Math.cos(angle) * radius * .235),
      y: sceneFrame.y + sceneFrame.height * (.51 + Math.sin(angle) * radius * .35),
    }
  }
  // Shoreline traced from the 1280 × 673 reference; mapped with the backdrop crop.
  const shoreline = [
    [221,290],[241,276],[245,229],[265,213],[269,195],[298,196],[335,183],
    [372,155],[380,136],[396,129],[413,144],[431,154],[435,179],[451,190],
    [470,177],[491,137],[497,108],[497,69],[548,53],[577,40],[597,27],
    [640,27],[674,33],[697,49],[706,71],[738,95],[742,125],[735,174],
    [739,186],[783,184],[810,189],[832,202],[851,199],[870,190],[886,209],
    [915,216],[930,235],[977,254],[984,287],[993,305],[1016,315],[1038,321],
    [1051,339],[1057,373],[1056,433],[1047,471],[1037,490],[1012,503],
    [989,510],[965,526],[932,529],[906,528],[880,536],[855,541],[835,540],
    [814,524],[791,544],[774,540],[743,542],[729,553],[722,579],[728,596],
    [749,607],[772,616],[779,633],[770,650],[748,662],[730,666],[724,644],
    [710,636],[674,637],[660,641],[649,651],[622,653],[605,647],[591,633],
    [582,606],[570,601],[549,605],[541,614],[519,601],[496,586],[480,552],
    [466,549],[438,552],[420,563],[410,560],[403,550],[422,532],[433,506],
    [427,494],[401,486],[366,485],[355,478],[330,472],[303,472],[281,465],
    [260,455],[264,439],[282,428],[316,418],[332,405],[347,382],[364,359],
    [369,339],[359,321],[342,300],[333,279],[309,266],[285,259],[274,272],
    [263,301],[255,316],[242,303],
  ]
  let outlineFrame, outlinePoints
  function waterOutline() {
    if (outlineFrame === sceneFrame) return outlinePoints
    outlineFrame = sceneFrame
    outlinePoints = shoreline.map(([x, y]) => ({
      x: sceneFrame.x + x / 1280 * sceneFrame.width,
      y: sceneFrame.y + y / 673 * sceneFrame.height,
    }))
    return outlinePoints
  }
  function waterDistance(x, y) {
    const points = waterOutline()
    let inside = false
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i], b = points[j]
      if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside
    }
    return inside ? 0 : 2
  }
  function keepInWater(x, y) {
    if (waterDistance(x, y) <= 1) return { x, y }
    const points = waterOutline()
    let nearest, distance = Infinity
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length]
      const dx = b.x - a.x, dy = b.y - a.y
      const t = clamp(((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy), 0, 1)
      const p = { x: a.x + t * dx, y: a.y + t * dy }
      const d = Math.hypot(x - p.x, y - p.y)
      if (d < distance) { nearest = p; distance = d }
    }
    return nearest
  }
  function periodAt(hour) {
    if (hour >= 8 && hour < 17) return 'day'
    if (hour >= 17 && hour < 19) return 'dusk'
    if (hour >= 5 && hour < 8) return 'dawn'
    return 'night'
  }
  function syncTime() {
    const date = new Date()
    const minute = timeSetting === 'auto' ? date.getHours() * 60 + date.getMinutes()
      : { dawn: 390, day: 720, dusk: 1080, night: 1320 }[timeSetting]
    if (minute === clockMinute) return
    clockMinute = minute
    period = periodAt(minute / 60)
    night = period === 'night'
    document.body.classList.toggle('night', night)
    document.body.dataset.period = period
    const label = { dawn: '清晨', day: '日间', dusk: '傍晚', night: '夜间' }[period]
    $('light').value = timeSetting
    $('light').setAttribute('aria-label', `时段设置：${timeSetting === 'auto' ? '自动' : '手动'} · ${label}`)
    $('light').title = timeSetting === 'auto' ? `${label} · 随本地时间自动切换` : `${label} · 手动固定时段`
    makeBackdrop()
  }
  function makeBackdrop() {
    const dpr = Math.min(devicePixelRatio || 1, 2)
    const oldWidth = width, oldHeight = height
    width = innerWidth; height = innerHeight
    for (const f of fish) {
      f.x *= width / (oldWidth || width); f.y *= height / (oldHeight || height)
      f.target = null
    }
    canvas.width = width * dpr; canvas.height = height * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    backdrop.width = width * dpr; backdrop.height = height * dpr
    const b = backdrop.getContext('2d'); b.scale(dpr, dpr)
    const scale = Math.max(width / 1723, height / 913)
    sceneFrame = { x: (width - 1723 * scale) / 2, y: (height - 913 * scale) / 2,
      width: 1723 * scale, height: 913 * scale }
    b.fillStyle = night ? '#062339' : '#123f39'
    b.fillRect(0, 0, width, height)
    const image = sceneImages[night ? 'night' : 'day']
    if (image.complete && image.naturalWidth) {
      b.drawImage(image, sceneFrame.x, sceneFrame.y, sceneFrame.width, sceneFrame.height)
    }
    if (period === 'dawn' || period === 'dusk') {
      b.fillStyle = period === 'dawn' ? '#b8d9db30' : '#51283655'
      b.fillRect(0, 0, width, height)
      b.globalCompositeOperation = 'soft-light'
      b.fillStyle = period === 'dawn' ? '#ffe8b866' : '#ed964a99'
      b.fillRect(0, 0, width, height)
      b.globalCompositeOperation = 'source-over'
    }
    // Cache soft sun shafts and leaf shadows once per clock minute, not per frame.
    sunlight.width = width; sunlight.height = height
    const light = sunlight.getContext('2d')
    if (!night) {
      const outline = waterOutline()
      light.beginPath(); light.moveTo(outline[0].x, outline[0].y)
      for (const p of outline.slice(1)) light.lineTo(p.x, p.y)
      light.closePath(); light.clip()
      const progress = clamp((clockMinute / 60 - 5) / 14, 0, 1)
      const sunX = width * (.12 + progress * .76)
      const warm = period === 'dusk' ? '255,174,88' : period === 'dawn' ? '255,226,174' : '255,249,207'
      for (let i = 0; i < 5; i++) {
        light.save()
        light.translate(sunX + (i - 2) * width * .085, -height * .12)
        light.rotate((progress - .5) * .65)
        light.scale(.17 + i % 2 * .06, 1)
        const glow = light.createRadialGradient(0, height * .3, 0, 0, height * .3, height * .8)
        glow.addColorStop(0, `rgba(${warm},0.17)`)
        glow.addColorStop(.5, `rgba(${warm},0.06)`)
        glow.addColorStop(1, `rgba(${warm},0)`)
        light.fillStyle = glow
        light.fillRect(-height, -height, height * 2, height * 3)
        light.restore()
      }
      light.filter = 'blur(9px)'
      for (let i = 0; i < 14; i++) {
        const p = waterPosition(i * 2.399, .75)
        ellipse(light, p.x + (progress - .5) * 60, p.y, 24 + i % 3 * 9, 7, '#123c3520', i * 2.399)
      }
    }
  }
  function koi(f, time) {
    const s = size(f), wag = Math.sin(time * 5 + f.phase), palette = patterns[f.pattern]
    ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.angle)
    if (night) ctx.globalAlpha = .82
    ellipse(ctx, -3, 9, s * .92, s * .31, '#00191c66')
    ctx.save(); ctx.translate(-s * .69, 0); ctx.rotate(wag * .22)
    ctx.fillStyle = palette[1] + 'aa'
    ctx.beginPath(); ctx.moveTo(2, 0); ctx.quadraticCurveTo(-s * .4, -s * .12, -s * (.6 + stage(f.level) * .015), -s * .38)
    ctx.quadraticCurveTo(-s * .48, 0, -s * .64, s * .38); ctx.quadraticCurveTo(-s * .22, s * .14, 2, 0); ctx.fill(); ctx.restore()
    for (const side of [-1, 1]) {
      ctx.save(); ctx.translate(s * .18, side * s * .17); ctx.rotate(side * (.2 + wag * .12))
      ellipse(ctx, -s * .06, side * s * .17, s * .3, s * (.13 + stage(f.level) * .009), palette[1] + '88', side * .8); ctx.restore()
    }
    ctx.beginPath(); ctx.moveTo(s, 0); ctx.bezierCurveTo(s * .77, -s * .42, -s * .3, -s * .36, -s * .78, 0)
    ctx.bezierCurveTo(-s * .3, s * .36, s * .77, s * .42, s, 0); ctx.closePath()
    const body = ctx.createLinearGradient(0, -s * .35, 0, s * .35)
    body.addColorStop(0, palette[1]); body.addColorStop(.45, palette[1]); body.addColorStop(1, f.pattern === 'ogon' ? '#957131' : '#809d93')
    ctx.fillStyle = body; ctx.fill()
    ctx.save(); ctx.clip()
    for (let i = 0; i < 4; i++) {
      ellipse(ctx, s * (.65 - i * .35), Math.sin(i * 7 + f.phase) * s * .12, s * .18, s * .2, palette[2], i)
      if (f.pattern === 'sanke' || f.pattern === 'shusui') ellipse(ctx, s * (.4 - i * .27), s * .08, s * .08, s * .105, '#25383a', i)
    }
    if (stage(f.level) >= 2) {
      ctx.strokeStyle = '#fff8d328'; ctx.lineWidth = .7
      for (let i = 0; i < 9; i++) { ctx.beginPath(); ctx.arc(s * (.6 - i * .14), 0, s * .18, -.9, .9); ctx.stroke() }
    }
    ctx.restore()
    ellipse(ctx, s * .7, -s * .14, 2, 2, '#162a29'); ellipse(ctx, s * .7, s * .14, 2, 2, '#162a29')
    ctx.strokeStyle = '#f1eed680'; ctx.lineWidth = .8
    for (const side of [-1, 1]) { ctx.beginPath(); ctx.moveTo(s * .9, side * s * .05); ctx.quadraticCurveTo(s * 1.12, side * s * .05, s * 1.1, side * s * .15); ctx.stroke() }
    if (!zen && f.id === selected) { ctx.strokeStyle = '#e6ce8a90'; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(0, 0, s * 1.32, s * .62, 0, 0, Math.PI * 2); ctx.stroke() }
    ctx.restore()
  }
  function interact(x, y) {
    if (!state || waterDistance(x, y) > 1) return
    const now = performance.now()
    // All input paths share the cooldown; rejected clicks never queue effects.
    if (now - lastInteraction < 500) return
    if (ripples.filter(r => r.age < window.koiWater.duration).length >= 3) return
    lastInteraction = now
    if (mode === 'feed' && food.length >= 45) return
    ripples.push({ x, y, age: 0, strong: mode === 'ripple' })
    if (mode !== 'feed') return
    for (let i = 0; i < 5; i++) {
      const px = x + random(-13, 13), py = y + random(-13, 13)
      food.push({ x: waterDistance(px, py) <= 1 ? px : x, y: waterDistance(px, py) <= 1 ? py : y, age: 0 })
    }
  }
  function refractWater(waves) {
    const padding = 16
    const left = Math.max(0, Math.floor(Math.min(...waves.map(r => r.x - r.age * window.koiWater.speed)) - padding))
    const top = Math.max(0, Math.floor(Math.min(...waves.map(r => r.y - r.age * window.koiWater.speed)) - padding))
    const right = Math.min(width, Math.ceil(Math.max(...waves.map(r => r.x + r.age * window.koiWater.speed)) + padding))
    const bottom = Math.min(height, Math.ceil(Math.max(...waves.map(r => r.y + r.age * window.koiWater.speed)) + padding))
    const w = right - left, h = bottom - top
    if (w <= 0 || h <= 0) return
    if (refractionCanvas.width !== w) refractionCanvas.width = w
    if (refractionCanvas.height !== h) refractionCanvas.height = h
    const dpr = canvas.width / width
    // Read the current scene, including underwater koi, before any wave displaces it.
    refractionContext.drawImage(canvas, left * dpr, top * dpr, w * dpr, h * dpr, 0, 0, w, h)
    const source = refractionContext.getImageData(0, 0, w, h)
    const pixels = window.koiWater.refract(source, waves.map(r => ({
      x: r.x - left, y: r.y - top, age: r.age, strength: (r.strong ? 1 : .45) * (reduced ? .4 : 1),
    })))
    refractionContext.putImageData(new ImageData(pixels, w, h), 0, 0)
    ctx.save()
    const outline = waterOutline()
    ctx.beginPath(); ctx.moveTo(outline[0].x, outline[0].y)
    for (const p of outline.slice(1)) ctx.lineTo(p.x, p.y)
    ctx.closePath()
    ctx.clip()
    ctx.drawImage(refractionCanvas, left, top)
    ctx.restore()
  }
  function animate(now) {
    if (now - lastClockCheck >= 1000) { lastClockCheck = now; syncTime() }
    const dt = Math.min((now - last) / 1000 || .016, .05); last = now
    const t = now / 1000
    ctx.drawImage(backdrop, 0, 0, width, height)
    for (const f of fish) {
      let target = food.reduce((best, pellet) => !best || Math.hypot(f.x - pellet.x, f.y - pellet.y) < Math.hypot(f.x - best.x, f.y - best.y) ? pellet : best, null)
      if (!target) {
        if (!f.target || Math.hypot(f.x - f.target.x, f.y - f.target.y) < 40) {
          do {
            f.target = { x: sceneFrame.x + random(.18, .82) * sceneFrame.width, y: sceneFrame.y + random(.05, .97) * sceneFrame.height }
          } while (waterDistance(f.target.x, f.target.y) > 1)
        }
        target = f.target
      }
      const distance = Math.hypot(target.x - f.x, target.y - f.y)
      const desired = Math.atan2(target.y - f.y, target.x - f.x)
      const delta = Math.atan2(Math.sin(desired - f.angle), Math.cos(desired - f.angle))
      f.angle += clamp(delta, -dt * 2.3, dt * 2.3)
      const speed = (food.length ? 65 : reduced ? 12 : 25) * Math.min(1, distance / 35 + .15)
      f.x = clamp(f.x + Math.cos(f.angle) * speed * dt, 40, width - 40)
      f.y = clamp(f.y + Math.sin(f.angle) * speed * dt, 40, height - 40)
      const distanceFromWater = waterDistance(f.x, f.y)
      if (distanceFromWater > 1) {
          const edge = keepInWater(f.x, f.y)
          f.x = edge.x; f.y = edge.y
          f.target = null
      }
      const pellet = food.indexOf(target)
      if (pellet >= 0 && distance < size(f) + 5 && Math.abs(delta) < .7) {
        food.splice(pellet, 1)
        if (ripples.filter(r => r.age < window.koiWater.duration).length < 3) ripples.push({ x: target.x, y: target.y, age: 0 })
      }
      koi(f, reduced ? t * .4 : t)
    }
    for (const p of food) { p.age += dt; ellipse(ctx, p.x + 2, p.y + 3, 3, 2, '#061f2399'); ellipse(ctx, p.x, p.y, 2.5, 2, '#d4a565') }
    food = food.filter(p => p.age < 25)
    if (!night) {
      ctx.save()
      ctx.globalAlpha = reduced ? .8 : .8 + Math.sin(t * .35) * .08
      ctx.drawImage(sunlight, 0, 0)
      ctx.restore()
    }
    for (const r of ripples) r.age += dt
    ripples = ripples.filter(r => r.age < window.koiWater.duration)
    if (ripples.length) refractWater(ripples)
    if (night) {
      for (let i = 0; i < 12; i++) {
        const p = waterPosition(i * 2.399, .86)
        const glow = reduced ? .45 : .35 + Math.sin(t * .7 + i * 3) * .25
        ctx.shadowColor = '#efe7a2'; ctx.shadowBlur = 9
        ellipse(ctx, p.x + Math.sin(t * .2 + i) * (reduced ? 0 : 4), p.y, 1.3, 1.3, `rgba(246,236,163,${glow})`)
      }
      ctx.shadowBlur = 0
    }
    if (state) state.eggs.forEach((e, i) => {
      const p = waterPosition(1.2, .72)
      ellipse(ctx, p.x + i * 12, p.y, 5, 6, '#e6d9a9')
      ellipse(ctx, p.x + i * 12, p.y, 2, 2, '#907b55')
    })
    if (!zen && keyboardActive) {
      ctx.strokeStyle = '#efdd9b'; ctx.beginPath(); ctx.arc(keyboardPoint.x * width, keyboardPoint.y * height, 12, 0, Math.PI * 2); ctx.stroke()
    }
    frame = requestAnimationFrame(animate)
  }
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0) return
    keyboardActive = false; interact(e.offsetX, e.offsetY)
  })
  $('zen').onclick = () => {
    zen = true
    document.querySelector('main').classList.add('zen')
    $('zen').setAttribute('aria-pressed', 'true')
    clearTimeout(noticeTimer)
    $('notice').classList.remove('show')
    keyboardActive = false
    canvas.focus({ preventScroll: true })
  }
  canvas.addEventListener('contextmenu', e => {
    if (!zen) return
    e.preventDefault()
    zen = false
    document.querySelector('main').classList.remove('zen')
    $('zen').setAttribute('aria-pressed', 'false')
    $('zen').focus({ preventScroll: true })
  })
  canvas.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Enter'].includes(e.key)) return
    e.preventDefault(); keyboardActive = true
    keyboardPoint.x = clamp(keyboardPoint.x + (e.key === 'ArrowRight' ? .03 : e.key === 'ArrowLeft' ? -.03 : 0), .05, .95)
    keyboardPoint.y = clamp(keyboardPoint.y + (e.key === 'ArrowDown' ? .03 : e.key === 'ArrowUp' ? -.03 : 0), .1, .9)
    if (e.key === ' ' || e.key === 'Enter') interact(keyboardPoint.x * width, keyboardPoint.y * height)
  })
  for (const id of ['feed', 'ripple']) $(id).onclick = () => {
    mode = id
    for (const key of ['feed', 'ripple']) { $(key).classList.toggle('active', key === id); $(key).setAttribute('aria-pressed', String(key === id)) }
    $('hint').textContent = id === 'feed' ? '轻点水面，送它们一餐小欢喜' : '轻点水面，看涟漪慢慢散开'
  }
  $('return').onclick = () => window.close()
  $('rename-form').onsubmit = async e => {
    e.preventDefault()
    try {
      const changed = await bridge.rename(selected, $('fish-name').value)
      notify(changed ? '名字已经写进庭院手记。' : '名字未变更，请填写 1–16 个字。')
    } catch { notify('名字保存失败，请稍后再试。') }
  }
  addEventListener('resize', makeBackdrop)
  $('light').onchange = () => {
    timeSetting = $('light').value
    clockMinute = -1
    syncTime()
    try { localStorage.setItem('koi-pond-time-setting', timeSetting) }
    catch { notify('时段已切换，本次设置未保存。') }
  }
  addEventListener('focus', syncTime)
  document.addEventListener('visibilitychange', () => {
    cancelAnimationFrame(frame)
    if (!document.hidden) { syncTime(); last = performance.now(); frame = requestAnimationFrame(animate) }
  })
  for (const [name, image] of Object.entries(sceneImages)) {
    image.onload = () => { if ((night ? 'night' : 'day') === name) makeBackdrop() }
    image.onerror = () => notify('庭院美术资源读取失败，请检查安装文件。')
    image.src = `koi-pond-${name}.webp`
  }
  syncTime()
  frame = requestAnimationFrame(animate)
  if (!bridge) { $('journey').textContent = '请从桌面壳的「后院鱼塘」菜单进入。'; return }
  // Subscribe before reading; a late initial snapshot must not overwrite a newer event.
  let received = false
  const unsubscribe = bridge.onState(next => { received = true; update(next) })
  bridge.getState().then(next => { if (!received) update(next) }).catch(() => {
    $('journey').textContent = '庭院存档读取失败，原存档已保留。请检查桌面日志。'
    notify('鱼塘暂未就绪，不影响继续聊天。')
  })
  addEventListener('pagehide', () => { unsubscribe(); cancelAnimationFrame(frame); clearTimeout(noticeTimer) }, { once: true })
})()
