/* Local canvas garden. No network, dependencies, or access to conversation content. */
(() => {
  'use strict'
  const $ = id => document.getElementById(id)
  const canvas = $('pond'), ctx = canvas.getContext('2d')
  const bridge = window.koiPond
  const patterns = { kohaku: ['红白', '#eee6ce', '#c44c32'], sanke: ['大正三色', '#e8e4d2', '#b74731'], ogon: ['黄金', '#e3bf63', '#ba8638'], shusui: ['秋翠', '#bacfd0', '#d77947'] }
  let state, selected, width = 0, height = 0, mode = 'feed', night = false
  let fish = [], food = [], ripples = [], last = 0, frame = 0, noticeTimer, lastFeed = 0
  let keyboardPoint = { x: .4, y: .55 }, keyboardActive = false
  const backdrop = document.createElement('canvas')
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const random = (min, max) => min + Math.random() * (max - min)
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v))
  function notify(text) {
    $('notice').textContent = text
    $('notice').classList.add('show')
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => $('notice').classList.remove('show'), 3500)
  }
  function stage(level) { return Math.min(10, Math.floor(level / 100)) }
  function size(f) { return 26 + stage(f.level) * 3 }
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
  function makeBackdrop() {
    const dpr = Math.min(devicePixelRatio || 1, 2)
    const oldWidth = width, oldHeight = height
    width = innerWidth; height = innerHeight
    for (const f of fish) { f.x *= width / (oldWidth || width); f.y *= height / (oldHeight || height) }
    canvas.width = width * dpr; canvas.height = height * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    backdrop.width = width * dpr; backdrop.height = height * dpr
    const b = backdrop.getContext('2d'); b.scale(dpr, dpr)
    const water = b.createRadialGradient(width * .4, height * .5, 10, width * .45, height * .5, width * .8)
    water.addColorStop(0, night ? '#163a40' : '#285753')
    water.addColorStop(.6, night ? '#0a222e' : '#123b39')
    water.addColorStop(1, '#061d21')
    b.fillStyle = water; b.fillRect(0, 0, width, height)
    // Fixed seed keeps the submerged stones in place between day/night changes.
    let seed = 7103
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
    for (let i = 0; i < 1600; i++) {
      const x = rand() * width, y = rand() * height, r = 3 + rand() * 15, rotation = rand() * 3
      ellipse(b, x, y, r, r * .65, `rgba(3,20,23,${.04 + rand() * .09})`, rotation)
      ellipse(b, x - 1, y - 2, r * .78, r * .48, `rgba(122,147,123,${night ? .02 : .035})`, rotation)
    }
    for (let i = 0; i < 19; i++) {
      const x = i < 10 ? -15 + i * 17 : width - (i - 10) * 17
      const y = i < 10 ? height - (i % 4) * 24 : 10 + (i % 4) * 20
      ellipse(b, x + 7, y + 12, 48, 33, '#051a1ca0', i)
      const rock = b.createRadialGradient(x - 12, y - 12, 2, x, y, 45)
      rock.addColorStop(0, night ? '#34463e' : '#65735a'); rock.addColorStop(1, '#192d2a')
      ellipse(b, x, y, 43, 29, rock, i)
      for (let j = 0; j < 15; j++) ellipse(b, x - 26 + rand() * 48, y - 18 + rand() * 27, 3 + rand() * 5, 2, '#71834d30')
    }
    for (let i = 0; i < 12; i++) {
      const x = i < 7 ? 70 + i * 27 : width - 80 - (i - 7) * 32
      const y = i < 7 ? height - 125 - Math.sin(i * 2) * 35 : 72 + Math.sin(i * 2) * 34
      const r = 20 + rand() * 15
      b.save(); b.translate(x, y); b.rotate(i * 2.3)
      ellipse(b, 5, 9, r, r * .76, '#021e2270')
      b.scale(1, .76)
      b.fillStyle = night ? '#2b5148' : '#547654'
      b.beginPath(); b.moveTo(0, 0); b.arc(0, 0, r, .2, Math.PI * 2 - .12); b.closePath(); b.fill()
      b.strokeStyle = '#b0c08a24'; b.lineWidth = 1
      for (let a = .3; a < 6.1; a += .45) { b.beginPath(); b.moveTo(0, 0); b.lineTo(Math.cos(a) * r * .92, Math.sin(a) * r * .92); b.stroke() }
      b.restore()
    }
    for (let i = 0; i < 9; i++) {
      b.save(); b.translate(128, height - 132); b.rotate(i * Math.PI * 2 / 9)
      ellipse(b, 0, -10, 7, 18, night ? '#a8a9ad' : '#e3ccbf'); b.restore()
    }
    ellipse(b, 128, height - 132, 7, 7, '#d6b56c')
  }
  function koi(f, time) {
    const s = size(f), wag = Math.sin(time * 5 + f.phase), palette = patterns[f.pattern]
    ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.angle)
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
    if (f.id === selected) { ctx.strokeStyle = '#e6ce8a90'; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(0, 0, s * 1.32, s * .62, 0, 0, Math.PI * 2); ctx.stroke() }
    ctx.restore()
  }
  function interact(x, y) {
    if (!state) return
    ripples.push({ x, y, age: 0 })
    ripples = ripples.slice(-24)
    if (mode !== 'feed') return
    if (performance.now() - lastFeed < 250 || food.length >= 45) { notify('饲料够啦，等它们慢慢吃。'); return }
    lastFeed = performance.now()
    for (let i = 0; i < 5; i++) food.push({ x: clamp(x + random(-13, 13), 15, width - 15), y: clamp(y + random(-13, 13), 15, height - 15), age: 0 })
  }
  function animate(now) {
    const dt = Math.min((now - last) / 1000 || .016, .05); last = now
    const t = now / 1000
    ctx.drawImage(backdrop, 0, 0, width, height)
    for (const f of fish) {
      let target = food.reduce((best, pellet) => !best || Math.hypot(f.x - pellet.x, f.y - pellet.y) < Math.hypot(f.x - best.x, f.y - best.y) ? pellet : best, null)
      if (!target) {
        if (!f.target || Math.hypot(f.x - f.target.x, f.y - f.target.y) < 40) f.target = { x: random(65, width - 290), y: random(160, height - 120) }
        target = f.target
      }
      const distance = Math.hypot(target.x - f.x, target.y - f.y)
      const desired = Math.atan2(target.y - f.y, target.x - f.x)
      const delta = Math.atan2(Math.sin(desired - f.angle), Math.cos(desired - f.angle))
      f.angle += clamp(delta, -dt * 2.3, dt * 2.3)
      const speed = (food.length ? 65 : reduced ? 12 : 25) * Math.min(1, distance / 35 + .15)
      f.x = clamp(f.x + Math.cos(f.angle) * speed * dt, 40, width - 40)
      f.y = clamp(f.y + Math.sin(f.angle) * speed * dt, 40, height - 40)
      const pellet = food.indexOf(target)
      if (pellet >= 0 && distance < size(f) + 5 && Math.abs(delta) < .7) {
        food.splice(pellet, 1); ripples.push({ x: target.x, y: target.y, age: 0 }); ripples = ripples.slice(-24)
      }
      koi(f, reduced ? t * .4 : t)
    }
    for (const p of food) { p.age += dt; ellipse(ctx, p.x + 2, p.y + 3, 3, 2, '#061f2399'); ellipse(ctx, p.x, p.y, 2.5, 2, '#d4a565') }
    food = food.filter(p => p.age < 25)
    for (const r of ripples) {
      r.age += dt
      ctx.strokeStyle = `rgba(190,218,194,${Math.max(0, .3 - r.age * .12)})`; ctx.lineWidth = 1
      for (let i = 0; i < 2; i++) { ctx.beginPath(); ctx.ellipse(r.x, r.y, 5 + r.age * 26 + i * 8, 3 + r.age * 20 + i * 6, 0, 0, Math.PI * 2); ctx.stroke() }
    }
    ripples = ripples.filter(r => r.age < 2.5)
    // Broad, soft surface reflections, kept deliberately faint over the koi.
    ctx.lineWidth = 1
    for (let i = 0; i < 18; i++) {
      ctx.strokeStyle = night ? '#bad9de08' : '#c2e4ce0b'
      ctx.beginPath()
      for (let x = 0; x <= width; x += 20) {
        const y = i * height / 18 + Math.sin(x / 95 + (reduced ? 0 : t * .22) + i) * 13
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
    if (state) state.eggs.forEach((e, i) => {
      ellipse(ctx, 182 + i * 15, height - 153, 5, 6, '#e6d9a9')
      ellipse(ctx, 182 + i * 15, height - 153, 2, 2, '#907b55')
    })
    if (keyboardActive) {
      ctx.strokeStyle = '#efdd9b'; ctx.beginPath(); ctx.arc(keyboardPoint.x * width, keyboardPoint.y * height, 12, 0, Math.PI * 2); ctx.stroke()
    }
    frame = requestAnimationFrame(animate)
  }
  canvas.addEventListener('pointerdown', e => { keyboardActive = false; interact(e.offsetX, e.offsetY) })
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
  $('light').onclick = () => { night = !night; $('light').textContent = night ? '☀ 天明' : '☾ 入夜'; $('light').setAttribute('aria-pressed', String(night)); makeBackdrop() }
  $('rename-form').onsubmit = async e => {
    e.preventDefault()
    try {
      const changed = await bridge.rename(selected, $('fish-name').value)
      notify(changed ? '名字已经写进庭院手记。' : '名字未变更，请填写 1–16 个字。')
    } catch { notify('名字保存失败，请稍后再试。') }
  }
  addEventListener('resize', makeBackdrop)
  document.addEventListener('visibilitychange', () => {
    cancelAnimationFrame(frame)
    if (!document.hidden) { last = performance.now(); frame = requestAnimationFrame(animate) }
  })
  makeBackdrop()
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
