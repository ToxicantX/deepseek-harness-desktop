import { KOI_POND_TOGGLE_ICON } from './koi-pond-toggle-icon.ts'

const STORAGE_KEY = 'dsh-pond-toggle-position'

function loadSavedPosition(): { left: number; top: number } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { left?: unknown; top?: unknown }
    if (typeof parsed.left === 'number' && typeof parsed.top === 'number' && Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) {
      return { left: parsed.left, top: parsed.top }
    }
  } catch {
    // Ignore invalid saved position
  }
  return null
}

function savePosition(left: number, top: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ left, top }))
  } catch {
    // Ignore storage failures
  }
}

export function installKoiPondToggle(toggle: () => Promise<void>, inPond = false): void {
  if (document.getElementById('dsh-pond-toggle')) return
  const host = document.createElement('div')
  host.id = 'dsh-pond-toggle'

  const size = 56
  const margin = 12

  // Default initial position or restored position
  const saved = loadSavedPosition()
  let currentLeft: number
  let currentTop: number

  const winW = window.innerWidth || document.documentElement.clientWidth || 800
  const winH = window.innerHeight || document.documentElement.clientHeight || 600

  if (saved && saved.left >= 0 && saved.left <= winW - size && saved.top >= 0 && saved.top <= winH - size) {
    currentLeft = saved.left
    currentTop = saved.top
  } else {
    currentLeft = Math.max(margin, winW - size - 16)
    currentTop = Math.max(margin, winH - size - 16)
  }

  Object.assign(host.style, {
    position: 'fixed',
    left: `${currentLeft}px`,
    top: `${currentTop}px`,
    width: `${size}px`,
    height: `${size}px`,
    zIndex: '2147483647',
    userSelect: 'none',
    webkitUserSelect: 'none',
    touchAction: 'none',
  })

  const shadow = host.attachShadow({ mode: 'open' })
  const style = new CSSStyleSheet()
  style.replaceSync(`
    :host {
      display: block;
    }
    button {
      width: 100%;
      height: 100%;
      box-sizing: border-box;
      border: none;
      border-radius: 0;
      background-color: transparent;
      background-image: url('${KOI_POND_TOGGLE_ICON}');
      background-repeat: no-repeat;
      background-position: center;
      background-size: contain;
      filter: drop-shadow(0 4px 10px rgba(0, 0, 0, 0.25));
      cursor: grab;
      padding: 0;
      -webkit-app-region: no-drag;
      transition: transform 0.15s ease, filter 0.15s ease;
      outline: none;
    }
    button:hover {
      transform: scale(1.12);
      filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.35));
    }
    button:active {
      cursor: grabbing;
      transform: scale(0.96);
    }
    button:focus-visible {
      filter: drop-shadow(0 0 6px #40877f);
    }
    button:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    span {
      position: absolute;
      top: 60px;
      right: 0;
      white-space: nowrap;
      font: 12px system-ui;
      background: #173e39;
      color: white;
      padding: 6px 10px;
      border-radius: 4px;
      display: none;
      pointer-events: none;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
    }
    button:hover + span,
    button:focus-visible + span {
      display: block;
    }
  `)
  shadow.adoptedStyleSheets = [style]

  const button = document.createElement('button')
  button.type = 'button'
  const label = inPond ? '切换回对话' : '后院鱼塘'
  button.title = label
  button.setAttribute('aria-label', label)
  button.setAttribute('aria-pressed', String(inPond))

  const tooltip = document.createElement('span')
  tooltip.textContent = label

  let isDragging = false
  let hasMoved = false
  let dragStartX = 0
  let dragStartY = 0
  let initialLeft = currentLeft
  let initialTop = currentTop

  function clampPosition(left: number, top: number) {
    const maxX = Math.max(margin, (window.innerWidth || document.documentElement.clientWidth) - size - margin)
    const maxY = Math.max(margin, (window.innerHeight || document.documentElement.clientHeight) - size - margin)
    return {
      x: Math.min(Math.max(margin, left), maxX),
      y: Math.min(Math.max(margin, top), maxY),
    }
  }

  button.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) return
    isDragging = true
    hasMoved = false
    dragStartX = event.clientX
    dragStartY = event.clientY
    initialLeft = host.offsetLeft
    initialTop = host.offsetTop
    button.setPointerCapture(event.pointerId)
  })

  button.addEventListener('pointermove', (event: PointerEvent) => {
    if (!isDragging) return
    const dx = event.clientX - dragStartX
    const dy = event.clientY - dragStartY
    if (!hasMoved && Math.hypot(dx, dy) > 4) {
      hasMoved = true
      tooltip.style.display = 'none'
    }
    if (hasMoved) {
      const targetX = initialLeft + dx
      const targetY = initialTop + dy
      const clamped = clampPosition(targetX, targetY)
      currentLeft = clamped.x
      currentTop = clamped.y
      host.style.left = `${currentLeft}px`
      host.style.top = `${currentTop}px`
    }
  })

  function onPointerUp(event: PointerEvent) {
    if (!isDragging) return
    isDragging = false
    try {
      if (button.hasPointerCapture(event.pointerId)) {
        button.releasePointerCapture(event.pointerId)
      }
    } catch {
      // Ignore pointer capture errors
    }
    if (hasMoved) {
      savePosition(currentLeft, currentTop)
      setTimeout(() => {
        tooltip.style.display = ''
      }, 100)
    }
  }

  button.addEventListener('pointerup', onPointerUp)
  button.addEventListener('pointercancel', onPointerUp)

  button.addEventListener('click', (event) => {
    if (hasMoved) {
      event.preventDefault()
      event.stopPropagation()
      hasMoved = false
      return
    }
    tooltip.textContent = label
    button.title = label
    button.disabled = true
    void toggle()
      .catch(() => {
        tooltip.textContent = '切换失败，请重试'
        button.title = tooltip.textContent
      })
      .finally(() => {
        button.disabled = false
      })
  })

  // Adjust on window resize if outside bounds
  window.addEventListener('resize', () => {
    const clamped = clampPosition(host.offsetLeft, host.offsetTop)
    currentLeft = clamped.x
    currentTop = clamped.y
    host.style.left = `${currentLeft}px`
    host.style.top = `${currentTop}px`
  })

  shadow.append(button, tooltip)
  document.body.append(host)
}
