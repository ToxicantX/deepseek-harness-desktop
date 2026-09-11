/* Local canvas garden. No network, dependencies, or access to conversation content. */
(() => {
  'use strict'
  const $ = id => document.getElementById(id)
  const canvas = $('pond'), ctx = canvas.getContext('2d')
  const bridge = window.koiPond
  const runningList = $('running-list'), runningPanel = $('running-sessions')
  const patterns = { kohaku: ['红白', '#eee6ce', '#c44c32'], sanke: ['大正三色', '#e8e4d2', '#b74731'], ogon: ['黄金', '#e3bf63', '#ba8638'], shusui: ['秋翠', '#bacfd0', '#d77947'] }
  const personalities = {
    curious: ['好奇', '会靠近缓慢移动的指针'], timid: ['胆小', '玩水时会迅速躲开'],
    greedy: ['贪吃', '发现饲料后游得更快'], calm: ['安静', '平时喜欢慢慢巡游'],
    lively: ['活泼', '游动比其他锦鲤更轻快'], clingy: ['亲人', '被选中后喜欢跟随指针'],
  }
  const personalityKeys = Object.keys(personalities)
  const firstTraits = { kohaku: 'curious', sanke: 'timid', ogon: 'greedy', shusui: 'calm' }
  const gardenEventPools = {
    dawn: ['petals', 'dragonfly', 'frog', 'leap'], day: ['petals', 'dragonfly', 'frog', 'leap'],
    dusk: ['petals', 'frog', 'fireflies', 'leap'], night: ['petals', 'frog', 'fireflies', 'leap'],
  }
  const gardenEventLabels = { petals: '花信入池', dragonfly: '蜻蜓掠水', frog: '蛙客来访', fireflies: '流萤照水', leap: '锦鲤跃水' }
  let state, selected, width = 0, height = 0, mode = 'feed', night = false, zen = false
  let fish = [], food = [], ripples = [], last = 0, frame = 0, noticeTimer, lastInteraction = -Infinity
  let feedBatch = 0, pointer = { x: 0, y: 0, active: false, movedAt: 0 }
  let gardenEvent, viewVisible = true
  let bonds = { dialogues: null, fish: {} }
  try {
    const saved = JSON.parse(localStorage.getItem('koi-pond-bonds') || 'null')
    if (saved && (saved.dialogues === null || Number.isSafeInteger(saved.dialogues) && saved.dialogues >= 0) && saved.fish && typeof saved.fish === 'object') bonds = saved
  } catch { /* Start a fresh local relationship record if the optional cache is invalid. */ }
  let keyboardPoint = { x: .4, y: .55 }, keyboardActive = false
  const backdrop = document.createElement('canvas')
  const sunlight = document.createElement('canvas')
  const atmosphere = document.createElement('canvas')
  let ambientPoints = [], seasonPoints = [], ambientPaint = -Infinity
  let period, season, clockMinute = -1, lastClockCheck = -Infinity
  let timeSetting = 'auto'
  try {
    const saved = localStorage.getItem('koi-pond-time-setting')
    if (['auto', 'dawn', 'day', 'dusk', 'night'].includes(saved)) timeSetting = saved
  } catch { /* Keep the default when local storage is unavailable. */ }
  let currentWeather = 'clear', weatherSetting = 'auto'
  let weatherDrops = [], weatherRipples = [], weatherMelts = [], lastWeatherFetch = -Infinity
  try {
    const savedW = localStorage.getItem('koi-pond-weather-setting')
    if (['auto', 'clear', 'overcast', 'drizzle', 'rain', 'storm', 'light_snow', 'snow', 'heavy_snow'].includes(savedW)) weatherSetting = savedW
  } catch { /* Keep the default when local storage is unavailable. */ }
  const weatherImages = { snow: new Image() }
  weatherImages.snow.decoding = 'async'; weatherImages.snow.src = 'koi-weather-snow.webp'
  weatherImages.snow.addEventListener('load', () => { ambientPaint = -Infinity })
  const refractionCanvas = document.createElement('canvas')
  const refractionContext = refractionCanvas.getContext('2d', { willReadFrequently: true })
  const sceneImages = { day: new Image(), night: new Image() }
  const eventImages = Object.fromEntries(Object.entries({
    petals: 'koi-event-petals.webp', dragonfly: 'koi-event-dragonfly.webp', frog: 'koi-event-frog.webp',
    fireflies: 'koi-event-firefly.webp', leap: 'koi-event-splash.webp',
  }).map(([kind, source]) => {
    const image = new Image()
    image.decoding = 'async'; image.src = source
    return [kind, image]
  }))
  const seasonImages = { spring: eventImages.petals, summer: eventImages.fireflies, autumn: new Image(), winter: new Image() }
  seasonImages.autumn.decoding = 'async'; seasonImages.autumn.src = 'koi-season-autumn-leaf.webp'
  seasonImages.winter.decoding = 'async'; seasonImages.winter.src = 'koi-season-winter-mist.webp'
  for (const image of new Set(Object.values(seasonImages))) image.addEventListener('load', () => { ambientPaint = -Infinity })
  const fishSprites = Object.fromEntries(
    ['kohaku', 'sanke', 'ogon', 'shusui'].flatMap(p =>
      ['fry', 'juvenile', 'adult'].map(s => {
        const img = new Image()
        img.decoding = 'async'; img.src = `koi-fish-${p}-${s}.webp`
        return [`${p}-${s}`, img]
      })
    )
  )
  let sceneFrame = { x: 0, y: 0, width: 1723, height: 913 }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const random = (min, max) => min + Math.random() * (max - min)
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v))
  function visualBudget(reducedMotion) {
    return reducedMotion ? { points: 8, refresh: Infinity } : { points: 18, refresh: 100 }
  }
  function seasonParticleCount(seasonName, reducedMotion) {
    const normal = { spring: 8, summer: 7, autumn: 9, winter: 2 }[seasonName]
    const reducedCount = { spring: 4, summer: 4, autumn: 4, winter: 1 }[seasonName]
    return reducedMotion ? reducedCount : normal
  }
  function hashId(value) {
    let hash = 2166136261
    for (const char of value) hash = Math.imul(hash ^ char.codePointAt(0), 16777619)
    return hash >>> 0
  }
  function gardenEventFor(dialogues, periodName) {
    const roll = hashId(`${dialogues}:garden-event`) / 0x100000000
    if (roll >= .42) return null
    const pool = gardenEventPools[periodName]
    return pool[Math.floor(roll / .42 * pool.length)]
  }
  function gardenEventParticleCount(kind, reducedMotion) {
    if (kind !== 'petals' && kind !== 'fireflies') return 0
    return reducedMotion ? 6 : kind === 'petals' ? 12 : 10
  }
  function personalityFor(f) {
    const key = f.trait || (f.generation === 1 ? firstTraits[f.pattern] : personalityKeys[hashId(f.id) % personalityKeys.length])
    f.trait = key
    return { key, name: personalities[key][0], description: personalities[key][1] }
  }
  function affinityOf(f) { return clamp(Number.isSafeInteger(bonds.fish[f.id]) ? bonds.fish[f.id] : 0, 0, 100) }
  function bondTitle(value) { return value >= 80 ? '形影相随' : value >= 50 ? '十分亲近' : value >= 20 ? '渐渐熟悉' : value >= 5 ? '初生好感' : '初次相识' }
  function saveBonds() {
    try { localStorage.setItem('koi-pond-bonds', JSON.stringify(bonds)) }
    catch { /* Relationship progress remains valid for this open window. */ }
  }
  function fishMeta(f) {
    return `${patterns[f.pattern][0]} · ${f.sex === 'female' ? '♀' : '♂'} · ${personalityFor(f).name} · 亲密 ${affinityOf(f)}`
  }
  function profileText(f) {
    const trait = personalityFor(f), affinity = affinityOf(f)
    return `${trait.name}：${trait.description} · 亲密度 ${affinity}/100（${bondTitle(affinity)}）。第 ${f.generation} 代 · 第 ${stage(f.level) + 1} 阶形态 · ${f.bred ? '已孕育下一代' : f.level >= 500 ? '等待成熟伴侣' : `距成熟还有 ${500 - f.level} 级`}。${f.level < 1000 ? `再升 ${100 - f.level % 100} 级舒展鳍尾。` : '体型已完全舒展，等级继续记录陪伴。'}`
  }
  function refreshBond(f) {
    const card = [...document.querySelectorAll('.fish-card')].find(item => item.dataset.fishId === f.id)
    if (card) card.querySelector('small').textContent = fishMeta(f)
    if (selected === f.id) $('lineage').textContent = profileText(f)
  }
  function addAffinity(f, amount) {
    const before = affinityOf(f), after = clamp(before + amount, 0, 100)
    if (after === before) return
    bonds.fish[f.id] = after
    saveBonds(); refreshBond(f)
  }
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
      const w = width || innerWidth || 1280, h = height || innerHeight || 720
      const initial = {
        x: w * (.35 + (i % 4) * .08), y: h * (.38 + Math.floor(i / 4) * .1),
        angle: random(0, Math.PI * 2), phase: random(0, 10), target: null,
      }
      if (existing && existing.x > 50 && existing.y > 50) {
        return Object.assign(existing, data)
      }
      return Object.assign(initial, data)
    })
    if (bonds.dialogues === null) bonds.dialogues = next.dialogues
    else if (next.dialogues > bonds.dialogues) {
      const gained = next.dialogues - bonds.dialogues
      for (const f of fish) bonds.fish[f.id] = clamp(affinityOf(f) + gained, 0, 100)
      bonds.dialogues = next.dialogues
    } else if (next.dialogues < bonds.dialogues) bonds.dialogues = next.dialogues
    saveBonds()
    if (previous && next.fish.length > previous.fish.length) notify('新生命抵达庭院，一条小锦鲤破壳了。')
    else if (previous && next.eggs.length > previous.eggs.length) notify('荷叶下藏着新期待：锦鲤产卵了。')
    else if (previous && next.dialogues > previous.dialogues) notify('又一段对话，池中锦鲤各长大 1 级。')
    if (viewVisible && !document.hidden && previous && next.dialogues > previous.dialogues && !gardenEvent) {
      const kind = gardenEventFor(next.dialogues, period)
      if (kind) startGardenEvent(kind)
    }
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
      card.dataset.fishId = f.id
      copy.className = 'fish-copy'
      copy.textContent = f.name
      sub.textContent = fishMeta(f)
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
      $('lineage').textContent = profileText(current)
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
    if (!points || !points.length) return { x, y }
    let nearest = points[0], distance = Infinity
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length]
      const dx = b.x - a.x, dy = b.y - a.y
      const denom = dx * dx + dy * dy
      const t = denom > 0 ? clamp(((x - a.x) * dx + (y - a.y) * dy) / denom, 0, 1) : 0
      const p = { x: a.x + t * dx, y: a.y + t * dy }
      const d = Math.hypot(x - p.x, y - p.y)
      if (d < distance) { nearest = p; distance = d }
    }
    return nearest || { x, y }
  }
  function eventPoints(count) {
    const points = []
    for (let attempts = 0; points.length < count && attempts < count * 30; attempts++) {
      const x = sceneFrame.x + random(.2, .82) * sceneFrame.width
      const y = sceneFrame.y + random(.08, .94) * sceneFrame.height
      if (waterDistance(x, y) <= 1) points.push({
        x, y, phase: random(0, Math.PI * 2), size: random(.75, 1.3), drift: random(-1, 1),
        speed: random(.65, 1.25), arc: random(20, 42), rise: random(-28, 28),
      })
    }
    return points
  }
  function startGardenEvent(kind) {
    const duration = { petals: 8, dragonfly: 6, frog: 9, fireflies: 8, leap: 2.4 }[kind]
    gardenEvent = { kind, started: performance.now() / 1000, duration, items: eventPoints(gardenEventParticleCount(kind, reduced)) }
    if (kind === 'dragonfly') Object.assign(gardenEvent, {
      direction: random(0, 1) < .5 ? -1 : 1, lane: random(.25, .43), sway: random(.04, .085),
      phase: random(0, Math.PI * 2), turns: random(-.35, .65),
    })
    if (kind === 'frog') {
      const spot = waterPosition(2.55, .88)
      Object.assign(gardenEvent, keepInWater(spot.x, spot.y), {
        phase: random(0, Math.PI * 2), drift: random(0, 1) < .5 ? -1 : 1, hopAt: random(.28, .58),
      })
    }
    if (kind === 'leap' && fish.length) {
      const koi = fish[Math.floor(random(0, fish.length))]
      Object.assign(gardenEvent, { fishId: koi.id, x: koi.x, y: koi.y })
      if (ripples.filter(r => r.age < window.koiWater.duration).length < 3) ripples.push({ x: koi.x, y: koi.y, age: 0 })
    }
    document.body.dataset.event = kind
    notify(`庭院小景 · ${gardenEventLabels[kind]}`)
  }
  function eventProgress(time) {
    return gardenEvent ? clamp((time - gardenEvent.started) / gardenEvent.duration, 0, 1) : 1
  }
  function dragonflyMotion(event, time, progress, reducedMotion) {
    const direction = event.direction === -1 ? -1 : 1
    const lane = event.lane ?? .32, sway = (event.sway ?? .055) * (reducedMotion ? .35 : 1)
    const phase = event.phase ?? 0, wave = progress * Math.PI * (3.5 + (event.turns ?? 0)) + phase
    const travel = sceneFrame.width + 80
    return {
      x: direction > 0 ? sceneFrame.x - 40 + progress * travel : sceneFrame.x + sceneFrame.width + 40 - progress * travel,
      y: sceneFrame.y + sceneFrame.height * (lane + Math.sin(wave) * sway) + Math.sin(time * 2.6 + phase) * (reducedMotion ? 1.5 : 4),
      rotation: direction * Math.PI / 2 + Math.cos(wave) * (reducedMotion ? .06 : .18),
      wing: reducedMotion ? 1 : .82 + Math.abs(Math.sin(time * 24 + phase)) * .18,
    }
  }
  function frogMotion(event, time, progress, reducedMotion) {
    const amount = reducedMotion ? .3 : 1, phase = event.phase ?? 0
    const hopProgress = (progress - (event.hopAt ?? .43)) / .18
    const hop = hopProgress > 0 && hopProgress < 1 ? Math.sin(hopProgress * Math.PI) : 0
    return {
      x: event.x + (event.drift ?? 1) * progress * 14 * amount + Math.sin(time * .8 + phase) * 1.5 * amount,
      y: event.y + Math.sin(time * 2.1 + phase) * 1.5 * amount - hop * 11 * amount,
      rotation: Math.sin(time * .9 + phase) * .026 * amount,
      hop,
    }
  }
  function fireflyMotion(item, time, progress, reducedMotion) {
    const amount = reducedMotion ? .32 : 1, phase = item.phase ?? 0
    const speed = item.speed ?? .9, arc = item.arc ?? 28, drift = item.drift ?? .5
    const x = item.x + (progress - .5) * drift * 80 * amount
      + Math.sin(time * speed + phase) * arc * amount + Math.sin(time * speed * 1.9 - phase) * 8 * amount
    const y = item.y + Math.cos(time * speed * .72 + phase) * arc * .58 * amount
      + Math.sin(time * speed * 1.37 + phase) * 9 * amount + (item.rise ?? 0) * progress * amount
    const dx = Math.cos(time * speed + phase) * arc * speed + Math.cos(time * speed * 1.9 - phase) * 15.2 * speed
    const dy = -Math.sin(time * speed * .72 + phase) * arc * .42 * speed
      + Math.cos(time * speed * 1.37 + phase) * 12.3 * speed + (item.rise ?? 0) / 8
    return { x, y, rotation: Math.atan2(dy, dx) + Math.PI / 2 }
  }
  function drawEventSprite(kind, x, y, spriteWidth, spriteHeight, rotation = 0, alpha = 1) {
    const image = eventImages[kind]
    if (!image?.complete || !image.naturalWidth) return false
    ctx.save(); ctx.globalAlpha *= alpha; ctx.translate(x, y); ctx.rotate(rotation)
    ctx.drawImage(image, -spriteWidth / 2, -spriteHeight / 2, spriteWidth, spriteHeight)
    ctx.restore()
    return true
  }
  function updateAndDrawWeather(dt, t) {
    if (currentWeather === 'clear') {
      weatherDrops = []
      weatherRipples = weatherRipples.filter(wr => (wr.age += dt) < wr.duration)
      weatherMelts = weatherMelts.filter(m => (m.age += dt) < m.duration)
      drawWeatherRipplesAndMelts()
      return
    }
    const isRain = currentWeather === 'drizzle' || currentWeather === 'rain' || currentWeather === 'storm'
    const isSnow = currentWeather === 'light_snow' || currentWeather === 'snow' || currentWeather === 'heavy_snow'
    const isOvercast = currentWeather === 'overcast'

    if (isOvercast || isRain || isSnow) {
      ctx.save()
      const washAlpha = isOvercast ? .18 : currentWeather === 'storm' ? .42 : isRain ? .26 : .20
      ctx.fillStyle = night ? `rgba(6, 20, 24, ${washAlpha * 1.2})` : `rgba(32, 48, 52, ${washAlpha})`
      ctx.fillRect(0, 0, width, height)
      ctx.restore()
    }

    if (!isRain && !isSnow) {
      weatherDrops = []
      weatherRipples = weatherRipples.filter(wr => (wr.age += dt) < wr.duration)
      weatherMelts = weatherMelts.filter(m => (m.age += dt) < m.duration)
      drawWeatherRipplesAndMelts()
      return
    }

    // High performance particle counts (keeps 60fps stable)
    const targetCount = reduced
      ? (currentWeather === 'drizzle' || currentWeather === 'light_snow' ? 10 : currentWeather === 'storm' || currentWeather === 'heavy_snow' ? 24 : 16)
      : (currentWeather === 'drizzle' ? 18 : currentWeather === 'rain' ? 36 : currentWeather === 'storm' ? 62
         : currentWeather === 'light_snow' ? 14 : currentWeather === 'snow' ? 24 : 42)

    while (weatherDrops.length < targetCount) {
      let targetX, targetY, inWater = false
      if (Math.random() < 0.8) {
        for (let tries = 0; tries < 6; tries++) {
          const rx = sceneFrame.x + random(.22, .80) * sceneFrame.width
          const ry = sceneFrame.y + random(.12, .88) * sceneFrame.height
          if (waterDistance(rx, ry) <= 1) { targetX = rx; targetY = ry; inWater = true; break }
        }
      }
      if (!targetX) {
        targetX = sceneFrame.x + random(0, 1) * sceneFrame.width
        targetY = sceneFrame.y + random(.1, .95) * sceneFrame.height
      }

      const speed = isRain
        ? (currentWeather === 'storm' ? random(900, 1300) : currentWeather === 'rain' ? random(700, 950) : random(500, 700))
        : (currentWeather === 'heavy_snow' ? random(85, 130) : currentWeather === 'snow' ? random(60, 95) : random(40, 70))
      const fallDist = random(120, 260)
      weatherDrops.push({
        x: targetX - (isRain ? (currentWeather === 'storm' ? 1.8 : 0.6) * fallDist * 0.2 : 0),
        y: targetY - fallDist,
        targetY, inWater, speed,
        slant: isRain ? (currentWeather === 'storm' ? 1.8 : 0.6) : random(-0.35, 0.35),
        size: isSnow ? random(10, currentWeather === 'heavy_snow' ? 18 : 15) : random(1, 2),
        phase: random(0, Math.PI * 2),
      })
    }

    const nextDrops = []
    const maxRipples = reduced ? 8 : 16
    const maxMelts = reduced ? 6 : 12

    for (const d of weatherDrops) {
      d.y += d.speed * dt
      d.x += (d.slant || 0) * d.speed * dt * 0.2
      if (d.y >= d.targetY) {
        if (d.inWater) {
          if (isRain && weatherRipples.length < maxRipples) {
            weatherRipples.push({
              x: d.x, y: d.targetY, age: 0,
              duration: currentWeather === 'storm' ? 0.75 : currentWeather === 'rain' ? 1.0 : 1.3,
              maxRadius: currentWeather === 'storm' ? 13 : currentWeather === 'rain' ? 16 : 11,
              alpha: currentWeather === 'storm' ? .48 : .36,
            })
          } else if (isSnow) {
            if (weatherMelts.length < maxMelts) {
              weatherMelts.push({
                x: d.x, y: d.targetY, age: 0,
                duration: random(0.8, 1.2),
                size: d.size * 0.65,
                driftX: random(-2, 2),
                driftY: random(1, 2.5),
                rotation: d.phase,
              })
            }
            if (weatherRipples.length < maxRipples) {
              weatherRipples.push({
                x: d.x, y: d.targetY, age: 0,
                duration: 0.9, maxRadius: 7, alpha: .22,
              })
            }
          }
        }
      } else {
        nextDrops.push(d)
      }
    }
    weatherDrops = nextDrops

    if (isRain) {
      ctx.save()
      ctx.strokeStyle = night ? 'rgba(180, 220, 230, 0.35)' : 'rgba(215, 240, 245, 0.5)'
      ctx.lineWidth = currentWeather === 'storm' ? 1.4 : 0.9
      ctx.beginPath()
      const streakLen = currentWeather === 'storm' ? 22 : currentWeather === 'rain' ? 15 : 9
      for (const d of weatherDrops) {
        ctx.moveTo(d.x, d.y)
        ctx.lineTo(d.x - (d.slant || 0) * streakLen * 0.2, d.y - streakLen)
      }
      ctx.stroke()
      ctx.restore()
    } else if (isSnow) {
      const sImg = weatherImages.snow
      const hasSprite = sImg?.complete && sImg.naturalWidth > 0
      ctx.save()
      ctx.globalAlpha = night ? .72 : .85
      for (const d of weatherDrops) {
        const driftX = Math.sin(t * 1.4 + d.phase) * 10
        const drawX = d.x + driftX, drawY = d.y
        if (hasSprite) {
          ctx.save()
          ctx.translate(drawX, drawY)
          ctx.rotate(d.phase + t * 0.4)
          ctx.drawImage(sImg, -d.size / 2, -d.size / 2, d.size, d.size)
          ctx.restore()
        } else {
          ellipse(ctx, drawX, drawY, d.size * 0.25, d.size * 0.25, 'rgba(245, 252, 255, 0.9)')
        }
      }
      ctx.restore()
    }

    weatherRipples = weatherRipples.filter(wr => (wr.age += dt) < wr.duration)
    weatherMelts = weatherMelts.filter(m => (m.age += dt) < m.duration)
    drawWeatherRipplesAndMelts()
  }

  function drawWeatherRipplesAndMelts() {
    if (!weatherRipples.length && !weatherMelts.length) return
    ctx.save()

    if (weatherRipples.length) {
      ctx.strokeStyle = night ? 'rgba(175, 225, 220, 0.35)' : 'rgba(225, 248, 245, 0.45)'
      ctx.lineWidth = 0.8
      ctx.beginPath()
      for (const r of weatherRipples) {
        const progress = r.age / r.duration
        const currentR = progress * r.maxRadius
        ctx.moveTo(r.x + currentR, r.y)
        ctx.ellipse(r.x, r.y, currentR, currentR * 0.55, 0, 0, Math.PI * 2)
      }
      ctx.stroke()
    }

    const sImg = weatherImages.snow
    const hasSprite = sImg?.complete && sImg.naturalWidth > 0
    for (const m of weatherMelts) {
      const progress = m.age / m.duration
      const dissolveFade = (1 - progress) * 0.65
      const currentSize = m.size * (1 - progress * 0.45)
      const x = m.x + m.driftX * progress, y = m.y + m.driftY * progress
      if (hasSprite) {
        ctx.save()
        ctx.globalAlpha = dissolveFade
        ctx.translate(x, y)
        ctx.rotate(m.rotation + progress * 0.3)
        ctx.drawImage(sImg, -currentSize / 2, -currentSize * 0.3, currentSize, currentSize * 0.6)
        ctx.restore()
      } else {
        ellipse(ctx, x, y, currentSize * 0.25, currentSize * 0.12, `rgba(235, 248, 255, ${dissolveFade})`)
      }
    }
    ctx.restore()
  }
  function drawGardenEvent(time) {
    if (!gardenEvent) return
    const event = gardenEvent, progress = eventProgress(time)
    if (progress >= 1) { gardenEvent = undefined; delete document.body.dataset.event; return }
    const fade = Math.min(1, progress * 5, (1 - progress) * 5)
    ctx.save(); ctx.globalAlpha = fade
    if (event.kind === 'petals') {
      for (const item of event.items) {
        const x = item.x + Math.sin(time * .55 + item.phase) * 28 * item.drift
        const y = item.y + progress * 70 + Math.cos(time * .4 + item.phase) * 6
        const rotation = item.phase + time * .22
        if (!drawEventSprite('petals', x, y, 10.5 * item.size, 14.5 * item.size, rotation, .92)) {
          ctx.save(); ctx.translate(x, y); ctx.rotate(rotation)
          ellipse(ctx, 0, 0, 4.2 * item.size, 1.7 * item.size, '#f3c8bdc7')
          ctx.strokeStyle = '#fff1dc6b'; ctx.lineWidth = .5; ctx.stroke(); ctx.restore()
        }
      }
    } else if (event.kind === 'dragonfly') {
      const motion = dragonflyMotion(event, time, progress, reduced)
      if (!drawEventSprite('dragonfly', motion.x, motion.y, 74 * motion.wing, 61, motion.rotation, .9)) {
        ctx.translate(motion.x, motion.y); ctx.rotate(motion.rotation - (event.direction === -1 ? -Math.PI / 2 : Math.PI / 2))
        ctx.strokeStyle = '#273d3399'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(9, 0); ctx.stroke()
        for (const side of [-1, 1]) {
          ctx.save(); ctx.rotate(side * (.42 + Math.sin(time * 22) * .16))
          ellipse(ctx, -1, side * 3, 10, 2.4, '#d9eee4a8', side * .25); ctx.restore()
        }
        ellipse(ctx, 9, 0, 2.3, 2.3, '#2d4e3d'); ellipse(ctx, -8, 0, 1.5, 1.5, '#8d6432')
      }
    } else if (event.kind === 'frog') {
      const motion = frogMotion(event, time, progress, reduced), frogSize = 86 * clamp(width / 1280, .82, 1.2)
      ellipse(ctx, motion.x, event.y + frogSize * .24, frogSize * (.35 - motion.hop * .08), frogSize * .1, '#001a1638')
      if (motion.hop > .05) {
        ctx.strokeStyle = `rgba(209,236,214,${motion.hop * .28})`; ctx.lineWidth = .8
        ctx.beginPath(); ctx.ellipse(motion.x, event.y + frogSize * .2, 18 + motion.hop * 17, 7 + motion.hop * 7, 0, 0, Math.PI * 2); ctx.stroke()
      }
      if (!drawEventSprite('frog', motion.x, motion.y, frogSize, frogSize, motion.rotation, .94)) {
        ctx.translate(motion.x, motion.y)
        ellipse(ctx, 0, 0, 10, 8, '#577f45'); ellipse(ctx, -7, 4, 7, 3, '#476f3c', -.3); ellipse(ctx, 7, 4, 7, 3, '#476f3c', .3)
        ellipse(ctx, -5, -6, 3.2, 3.2, '#6f9856'); ellipse(ctx, 5, -6, 3.2, 3.2, '#6f9856')
        ellipse(ctx, -5, -6, 1.1, 1.1, '#17251a'); ellipse(ctx, 5, -6, 1.1, 1.1, '#17251a')
        ctx.strokeStyle = '#d6dfa75e'; ctx.lineWidth = .7; ctx.beginPath(); ctx.arc(0, 0, 5, .25, Math.PI - .25); ctx.stroke()
      }
    } else if (event.kind === 'fireflies') {
      for (const item of event.items) {
        const motion = fireflyMotion(item, time, progress, reduced)
        const alpha = .32 + Math.max(0, Math.sin(time * 2 + item.phase)) * .58
        ctx.save(); ctx.globalAlpha *= alpha; ctx.shadowColor = '#ffe782'; ctx.shadowBlur = 11
        if (!drawEventSprite('fireflies', motion.x, motion.y, 16 * item.size, 23 * item.size, motion.rotation)) {
          ellipse(ctx, motion.x, motion.y, 1.4 * item.size, 1.1 * item.size, '#ffef89')
        }
        ctx.restore()
      }
    } else if (event.kind === 'leap') {
      const pulse = Math.sin(progress * Math.PI)
      const splashSize = 68 + pulse * 92
      if (!drawEventSprite('leap', event.x, event.y - pulse * 5, splashSize, splashSize * .98, progress * .08, .78)) {
        ctx.strokeStyle = `rgba(221,245,226,${.45 * (1 - progress)})`; ctx.lineWidth = 1
        ctx.beginPath(); ctx.ellipse(event.x, event.y, 8 + progress * 44, 4 + progress * 24, 0, 0, Math.PI * 2); ctx.stroke()
        ctx.fillStyle = '#d8f2df9c'
        for (let i = 0; i < 6; i++) {
          const angle = i / 6 * Math.PI * 2
          ellipse(ctx, event.x + Math.cos(angle) * (8 + progress * 22), event.y + Math.sin(angle) * (5 + progress * 12) - pulse * 11, 1.2, 2.1, '#d8f2df9c', angle)
        }
      }
    }
    ctx.restore()
  }
  function mapWmoToWeather(code, rain = 0, snowfall = 0) {
    if (snowfall > 0 || (code >= 71 && code <= 77) || (code >= 85 && code <= 86)) {
      if (code === 75 || code === 86 || snowfall >= 1.5) return 'heavy_snow'
      if (code === 73 || (snowfall >= 0.5 && snowfall < 1.5)) return 'snow'
      return 'light_snow'
    }
    if (code === 95 || code === 96 || code === 99 || code === 65 || code === 82 || rain >= 6) return 'storm'
    if (code === 63 || code === 81 || (rain >= 1.5 && rain < 6)) return 'rain'
    if (code === 51 || code === 53 || code === 55 || code === 56 || code === 57 || code === 61 || code === 80 || (rain > 0 && rain < 1.5)) return 'drizzle'
    if (code === 1 || code === 2 || code === 3 || code === 45 || code === 48) return 'overcast'
    return 'clear'
  }
  const weatherLabels = {
    clear: '晴天', overcast: '阴天', drizzle: '小雨', rain: '中雨',
    storm: '暴雨', light_snow: '小雪', snow: '中雪', heavy_snow: '大雪',
  }
  function updateWeatherUI() {
    const label = weatherLabels[currentWeather] || '晴天'
    document.body.dataset.weather = currentWeather
    if ($('weather-name')) {
      $('weather-name').textContent = label
      $('weather-name').title = weatherSetting === 'auto' ? `当前实时天气：${label} (每20分钟自 Open-Meteo 同步)` : `当前手动天气：${label}`
    }
    if ($('weather-select')) {
      $('weather-select').value = weatherSetting
      $('weather-select').setAttribute('aria-label', `天气设置：${weatherSetting === 'auto' ? '实时天气 (Open-Meteo)' : `手动 · ${label}`}`)
      $('weather-select').title = weatherSetting === 'auto' ? `实时天气 · ${label} (Open-Meteo 实时同步)` : `手动 · ${label}`
    }
  }
  async function fetchLiveWeather() {
    if (weatherSetting !== 'auto' || !bridge?.getLiveWeather) return
    try {
      const data = await bridge.getLiveWeather()
      if (data && typeof data.weatherCode === 'number') {
        const nextW = mapWmoToWeather(data.weatherCode, data.rain, data.snowfall)
        if (weatherSetting === 'auto') {
          currentWeather = nextW
          updateWeatherUI()
        }
      }
    } catch {}
  }
  function syncWeather(forceFetch = false) {
    if (weatherSetting !== 'auto') {
      currentWeather = weatherSetting
      updateWeatherUI()
      return
    }
    updateWeatherUI()
    const now = performance.now()
    if (forceFetch || now - lastWeatherFetch >= 20 * 60 * 1000) {
      lastWeatherFetch = now
      fetchLiveWeather()
    }
  }
  function periodAt(hour) {
    if (hour >= 8 && hour < 17) return 'day'
    if (hour >= 17 && hour < 19) return 'dusk'
    if (hour >= 5 && hour < 8) return 'dawn'
    return 'night'
  }
  function seasonAt(month) {
    if (month >= 2 && month < 5) return 'spring'
    if (month >= 5 && month < 8) return 'summer'
    if (month >= 8 && month < 11) return 'autumn'
    return 'winter'
  }
  function syncTime() {
    const date = new Date()
    const minute = timeSetting === 'auto' ? date.getHours() * 60 + date.getMinutes()
      : { dawn: 390, day: 720, dusk: 1080, night: 1320 }[timeSetting]
    const nextSeason = seasonAt(date.getMonth())
    if (minute === clockMinute && nextSeason === season) return
    clockMinute = minute
    season = nextSeason
    period = periodAt(minute / 60)
    night = period === 'night'
    document.body.classList.toggle('night', night)
    document.body.dataset.period = period
    document.body.dataset.season = season
    const label = { dawn: '清晨', day: '日间', dusk: '傍晚', night: '夜间' }[period]
    const seasonLabel = { spring: '春景', summer: '夏景', autumn: '秋景', winter: '冬景' }[season]
    $('light').value = timeSetting
    $('light').setAttribute('aria-label', `时段设置：${timeSetting === 'auto' ? '自动' : '手动'} · ${label}`)
    $('light').title = timeSetting === 'auto' ? `${label} · 随本地时间自动切换` : `${label} · 手动固定时段`
    $('period-name').textContent = label
    $('season-name').textContent = seasonLabel
    $('season-name').title = '按电脑本地日期自动切换：春 3–5 月，夏 6–8 月，秋 9–11 月，冬 12–2 月'
    $('clock').textContent = timeSetting === 'auto'
      ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : '手动'
    makeBackdrop()
  }
  function makeAmbientPoints() {
    const count = visualBudget(reduced).points
    ambientPoints = []
    for (let attempts = 0; ambientPoints.length < count && attempts < count * 30; attempts++) {
      const x = sceneFrame.x + random(.2, .82) * sceneFrame.width
      const y = sceneFrame.y + random(.08, .94) * sceneFrame.height
      if (waterDistance(x, y) <= 1) ambientPoints.push({ x, y, phase: random(0, Math.PI * 2), size: random(.7, 1.35), drift: random(-1, 1) })
    }
  }
  function makeSeasonPoints() {
    const count = seasonParticleCount(season, reduced)
    seasonPoints = []
    if (season === 'winter') {
      for (let i = 0; i < count; i++) seasonPoints.push({ phase: random(0, Math.PI * 2), y: .36 + i * .28, size: random(.82, 1.12) })
      return
    }
    for (let attempts = 0; seasonPoints.length < count && attempts < count * 30; attempts++) {
      const x = sceneFrame.x + random(.18, .84) * sceneFrame.width
      const y = sceneFrame.y + random(.08, .94) * sceneFrame.height
      if (waterDistance(x, y) <= 1) seasonPoints.push({
        x, y, phase: random(0, Math.PI * 2), offset: random(0, 1), size: random(.72, 1.3),
        drift: random(-1, 1), speed: random(.55, 1.18), arc: random(18, 38), rise: random(-22, 22),
      })
    }
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
    atmosphere.width = width; atmosphere.height = height
    ambientPaint = -Infinity
    makeAmbientPoints()
    makeSeasonPoints()
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
  function drawSeasonAtmosphere(a, time) {
    const image = seasonImages[season]
    if (!image?.complete || !image.naturalWidth) return
    const motion = reduced ? 0 : time
    if (season === 'winter') {
      a.globalCompositeOperation = 'screen'
      for (const point of seasonPoints) {
        const mistWidth = sceneFrame.width * .58 * point.size
        const mistHeight = mistWidth * image.naturalHeight / image.naturalWidth
        const x = sceneFrame.x + sceneFrame.width * (.5 + Math.sin(motion * .025 + point.phase) * .18)
        const y = sceneFrame.y + sceneFrame.height * point.y + Math.cos(motion * .04 + point.phase) * 8
        a.save(); a.globalAlpha = (period === 'dawn' || night ? .3 : .22) * point.size
        a.drawImage(image, x - mistWidth / 2, y - mistHeight / 2, mistWidth, mistHeight); a.restore()
      }
      return
    }
    if (season === 'summer' && period !== 'dusk' && !night) return
    for (const point of seasonPoints) {
      if (season === 'summer') {
        const fly = fireflyMotion(point, motion, (point.offset + motion * .035) % 1, reduced)
        const alpha = .28 + Math.max(0, Math.sin(motion * 1.8 + point.phase)) * .5
        a.save(); a.globalAlpha = alpha; a.shadowColor = '#ffe47a'; a.shadowBlur = 10
        a.translate(fly.x, fly.y); a.rotate(fly.rotation)
        a.drawImage(image, -7 * point.size, -10 * point.size, 14 * point.size, 20 * point.size); a.restore()
        continue
      }
      const fall = (point.offset + motion * point.speed * (season === 'spring' ? .018 : .014)) % 1
      const x = point.x + Math.sin(motion * .34 + point.phase) * point.arc * point.drift
      const y = sceneFrame.y + fall * sceneFrame.height
      const leaf = season === 'autumn', spriteWidth = (leaf ? 17 : 10) * point.size, spriteHeight = (leaf ? 16 : 14) * point.size
      a.save(); a.globalAlpha = leaf ? .72 : .58; a.translate(x, y); a.rotate(point.phase + motion * (leaf ? .18 : .22) * point.drift)
      a.drawImage(image, -spriteWidth / 2, -spriteHeight / 2, spriteWidth, spriteHeight); a.restore()
    }
  }
  function drawAtmosphere(time) {
    const budget = visualBudget(reduced)
    if (ambientPaint > -Infinity && (time - ambientPaint) * 1000 < budget.refresh) return
    ambientPaint = time
    const a = atmosphere.getContext('2d')
    a.clearRect(0, 0, width, height)
    const outline = waterOutline()
    a.save(); a.beginPath(); a.moveTo(outline[0].x, outline[0].y)
    for (const point of outline.slice(1)) a.lineTo(point.x, point.y)
    a.closePath(); a.clip()
    if ((period === 'dawn' || period === 'night') && season !== 'winter') {
      for (let i = 0; i < 3; i++) {
        const y = height * (.45 + i * .16) + Math.sin(time * .07 + i) * 9
        const haze = a.createLinearGradient(0, y - 45, 0, y + 45)
        haze.addColorStop(0, 'rgba(211,235,224,0)')
        haze.addColorStop(.5, period === 'dawn' ? 'rgba(225,241,226,.075)' : 'rgba(159,194,199,.045)')
        haze.addColorStop(1, 'rgba(211,235,224,0)')
        a.fillStyle = haze; a.fillRect(0, y - 45, width, 90)
      }
    }
    a.globalCompositeOperation = 'screen'
    for (let i = 0; i < ambientPoints.length; i++) {
      const point = ambientPoints[i], motion = reduced ? 0 : time
      const x = point.x + Math.sin(motion * .16 + point.phase) * 11 * point.drift
      const y = point.y + Math.cos(motion * .13 + point.phase) * 5
      if (night || period === 'dusk') {
        const alpha = .04 + Math.max(0, Math.sin(motion * .7 + point.phase)) * .1
        const glow = a.createRadialGradient(x, y, 0, x, y, 9 * point.size)
        glow.addColorStop(0, `rgba(186,221,215,${alpha})`); glow.addColorStop(1, 'rgba(186,221,215,0)')
        a.fillStyle = glow; a.fillRect(x - 12, y - 12, 24, 24)
        ellipse(a, x, y, .8 * point.size, .6 * point.size, `rgba(216,239,228,${alpha + .12})`)
      } else {
        const alpha = .055 + Math.max(0, Math.sin(motion * .45 + point.phase)) * .12
        a.strokeStyle = `rgba(244,255,222,${alpha})`; a.lineWidth = .75 * point.size
        a.beginPath(); a.moveTo(x - 11 * point.size, y)
        a.quadraticCurveTo(x, y - 5 * point.size, x + 12 * point.size, y + 1.5 * point.size); a.stroke()
      }
    }
    drawSeasonAtmosphere(a, time)
    a.restore()
  }
  function koi(f, time) {
    const s = size(f), wag = Math.sin(time * 5 + f.phase), palette = patterns[f.pattern]
    const leaping = gardenEvent?.kind === 'leap' && gardenEvent.fishId === f.id
    const lift = leaping ? Math.sin(eventProgress(time) * Math.PI) * s * 1.45 : 0
    if (lift > 0) ellipse(ctx, f.x, f.y + 8, s * (.84 - lift / (s * 12)), s * .23, '#00171458')
    ctx.save(); ctx.translate(f.x, f.y - lift); ctx.rotate(f.angle)
    if (lift > 0) ctx.scale(1 + lift / (s * 16), 1 + lift / (s * 24))
    if (night) ctx.globalAlpha = .82
    if (!lift) ellipse(ctx, -3, 9, s * .92, s * .31, '#00191c66')

    const stgKey = f.level < 200 ? 'fry' : f.level < 500 ? 'juvenile' : 'adult'
    const sprite = fishSprites[`${f.pattern}-${stgKey}`]
    if (sprite?.complete && sprite.naturalWidth) {
      const spriteW = s * 3.2
      const spriteH = spriteW * (sprite.naturalHeight / sprite.naturalWidth)
      const slices = 14
      const sliceW = spriteW / slices
      const imgSliceW = sprite.naturalWidth / slices
      const headOffset = spriteW * .64

      for (let i = slices - 1; i >= 0; i--) {
        const u = (i + .5) / slices
        const tailFactor = Math.pow(Math.max(0, (0.78 - u) / 0.78), 1.5)
        const wave = Math.sin(time * 5 + f.phase - (1 - u) * 2.6)
        const lateralOffset = wave * tailFactor * s * .58
        const sliceX = i * sliceW - headOffset
        const sliceY = -spriteH / 2 + lateralOffset

        ctx.drawImage(
          sprite,
          i * imgSliceW, 0, imgSliceW, sprite.naturalHeight,
          sliceX, sliceY, sliceW + .65, spriteH
        )
      }
        } else {
      ctx.strokeStyle = night ? '#a7d7d21c' : '#e8f8d82a'; ctx.lineWidth = .65
      for (const side of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(-s * .55, side * s * .22)
        ctx.quadraticCurveTo(-s * 1.15, side * s * (.35 + wag * .04), -s * 1.55, side * s * .2); ctx.stroke()
      }
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
      ctx.fillStyle = body; ctx.fill(); ctx.strokeStyle = '#fffbe04a'; ctx.lineWidth = .7; ctx.stroke()
      ctx.save(); ctx.clip()
      for (let i = 0; i < 4; i++) {
        ellipse(ctx, s * (.65 - i * .35), Math.sin(i * 7 + f.phase) * s * .12, s * .18, s * .2, palette[2], i)
        if (f.pattern === 'sanke' || f.pattern === 'shusui') ellipse(ctx, s * (.4 - i * .27), s * .08, s * .08, s * .105, '#25383a', i)
      }
      ctx.restore()
      ellipse(ctx, s * .7, -s * .14, 2, 2, '#162a29'); ellipse(ctx, s * .7, s * .14, 2, 2, '#162a29')
      ctx.strokeStyle = '#f1eed680'; ctx.lineWidth = .8
      for (const side of [-1, 1]) { ctx.beginPath(); ctx.moveTo(s * .9, side * s * .05); ctx.quadraticCurveTo(s * 1.12, side * s * .05, s * 1.1, side * s * .15); ctx.stroke() }
    }
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
    if (mode !== 'feed') {
      for (const f of fish) {
        const trait = personalityFor(f).key
        if (trait === 'timid') {
          const angle = Math.atan2(f.y - y, f.x - x), edge = keepInWater(f.x + Math.cos(angle) * 180, f.y + Math.sin(angle) * 180)
          f.target = edge; f.startledUntil = now + 1800
        } else if (trait === 'curious' || trait === 'lively') f.target = { x, y }
      }
      const companion = fish.find(f => f.id === selected)
      if (companion && Math.hypot(companion.x - x, companion.y - y) < 220 && (!companion.lastPlayBond || now - companion.lastPlayBond >= 20000)) {
        companion.lastPlayBond = now; addAffinity(companion, 1)
      }
      return
    }
    feedBatch++
    for (let i = 0; i < 5; i++) {
      const px = x + random(-13, 13), py = y + random(-13, 13)
      food.push({ x: waterDistance(px, py) <= 1 ? px : x, y: waterDistance(px, py) <= 1 ? py : y, age: 0, batch: feedBatch })
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
        const trait = personalityFor(f).key
        if (pointer.active && now - pointer.movedAt < 1500 && (trait === 'curious' || (trait === 'clingy' && selected === f.id))) {
          f.target = { x: pointer.x, y: pointer.y }
        }
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
      const trait = personalityFor(f).key
      const temperament = food.length && trait === 'greedy' ? 1.35 : trait === 'lively' ? 1.22 : trait === 'calm' ? .8 : f.startledUntil > now ? 1.35 : 1
      const leaping = gardenEvent?.kind === 'leap' && gardenEvent.fishId === f.id
      const speed = leaping ? 0 : (food.length ? 65 : reduced ? 12 : 25) * temperament * (1 + affinityOf(f) / 1000) * Math.min(1, distance / 35 + .15)
      f.x = clamp(f.x + Math.cos(f.angle) * speed * dt, 40, width - 40)
      f.y = clamp(f.y + Math.sin(f.angle) * speed * dt, 40, height - 40)
      const distanceFromWater = waterDistance(f.x, f.y)
      if (distanceFromWater > 1) {
          const edge = keepInWater(f.x, f.y)
          const cx = sceneFrame.x + sceneFrame.width * .53, cy = sceneFrame.y + sceneFrame.height * .48
          const inwardAngle = Math.atan2(cy - (edge?.y ?? f.y), cx - (edge?.x ?? f.x))
          // Nudge 8px towards pond center to escape boundary trapping
          if (edge && typeof edge.x === 'number' && typeof edge.y === 'number') {
            f.x = edge.x + Math.cos(inwardAngle) * 8
            f.y = edge.y + Math.sin(inwardAngle) * 8
          }
          f.angle = inwardAngle + random(-.3, .3)
          // Assign an explicit target in the open pond center to swim away from the bank
          f.target = {
            x: cx + random(-0.15, 0.15) * sceneFrame.width,
            y: cy + random(-0.15, 0.15) * sceneFrame.height,
          }
      }
      const pellet = food.indexOf(target)
      if (pellet >= 0 && distance < size(f) + 5 && Math.abs(delta) < .7) {
        food.splice(pellet, 1)
        if (f.lastFedBatch !== target.batch) { f.lastFedBatch = target.batch; addAffinity(f, 2) }
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
    drawAtmosphere(t)
    ctx.drawImage(atmosphere, 0, 0, width, height)
    drawGardenEvent(t)
    updateAndDrawWeather(dt, t)
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
  canvas.addEventListener('pointermove', e => {
    if (waterDistance(e.offsetX, e.offsetY) > 1) { pointer.active = false; return }
    pointer = { x: e.offsetX, y: e.offsetY, active: true, movedAt: performance.now() }
  })
  canvas.addEventListener('pointerleave', () => { pointer.active = false })
  $('zen').onclick = () => {
    zen = true
    document.querySelector('main').classList.add('zen')
    $('zen').setAttribute('aria-pressed', 'true')
    clearTimeout(noticeTimer)
    $('notice').classList.remove('show')
    keyboardActive = false
    canvas.focus({ preventScroll: true })
  }
  const closeButton = $('close-pond')
  if (closeButton) {
    closeButton.onclick = () => {
      if (typeof window.koiPond?.close === 'function') {
        void window.koiPond.close().catch(console.error)
      }
    }
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
  function renderRunningSessions(sessions) {
    const valid = Array.isArray(sessions) ? sessions.filter(item => item && typeof item.id === 'string') : []
    runningPanel.hidden = valid.length === 0
    $('running-count').textContent = String(valid.length)
    runningList.replaceChildren(...valid.map(item => {
      const row = document.createElement('div'); row.className = 'running-item'
      const name = document.createElement('strong'); name.textContent = '会话 ' + item.id.slice(0, 8)
      const state = document.createElement('span'); state.textContent = '执行中'
      row.append(name, state); return row
    }))
  }
  $('rename-form').onsubmit = async e => {
    e.preventDefault()
    try {
      const changed = await bridge.rename(selected, $('fish-name').value)
      notify(changed ? '名字已经写进庭院手记。' : '名字未变更，请填写 1–16 个字。')
    } catch { notify('名字保存失败，请稍后再试。') }
  }
  addEventListener('resize', makeBackdrop)
  if ($('weather-select')) {
    $('weather-select').onchange = () => {
      weatherSetting = $('weather-select').value
      syncWeather(true)
      try { localStorage.setItem('koi-pond-weather-setting', weatherSetting) }
      catch { notify('天气已切换，本次设置未保存。') }
    }
  }

  $('light').onchange = () => {
    timeSetting = $('light').value
    clockMinute = -1
    syncTime()
    try { localStorage.setItem('koi-pond-time-setting', timeSetting) }
    catch { notify('时段已切换，本次设置未保存。') }
  }
  addEventListener('focus', () => { syncTime(); syncWeather(); })
  const syncVisibility = () => {
    cancelAnimationFrame(frame)
    if (viewVisible && !document.hidden) { syncTime(); last = performance.now(); frame = requestAnimationFrame(animate) }
  }
  document.addEventListener('visibilitychange', syncVisibility)
  for (const [name, image] of Object.entries(sceneImages)) {
    image.onload = () => { if ((night ? 'night' : 'day') === name) makeBackdrop() }
    image.onerror = () => notify('庭院美术资源读取失败，请检查安装文件。')
    image.src = `koi-pond-${name}.webp`
  }
  syncTime()
  syncWeather(true)
  frame = requestAnimationFrame(animate)
  if (!bridge) { $('journey').textContent = '鱼塘连接不可用'; return }
  // Subscribe before reading; a late initial snapshot must not overwrite a newer event.
  let received = false
  const unsubscribeVisibility = bridge.onVisibility(visible => {
    viewVisible = visible
    if (!visible) { gardenEvent = undefined; $('notice').classList.remove('show'); clearTimeout(noticeTimer) }
    syncVisibility()
  })
  const unsubscribeRunning = bridge.onRunningSessions(renderRunningSessions)
  const unsubscribe = bridge.onState(next => { received = true; update(next) })
  bridge.getState().then(next => { if (!received) update(next) }).catch(() => {
    $('journey').textContent = '庭院存档读取失败，原存档已保留。请检查桌面日志。'
    notify('鱼塘暂未就绪，不影响继续聊天。')
  })
  addEventListener('pagehide', () => { unsubscribe(); unsubscribeVisibility(); unsubscribeRunning(); cancelAnimationFrame(frame); clearTimeout(noticeTimer) }, { once: true })
})()
