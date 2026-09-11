import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { installKoiPondToggle } from '../src/koi-pond-toggle.ts'
import { KOI_POND_TOGGLE_ICON } from '../src/koi-pond-toggle-icon.ts'

class MockElement {
  id = ''
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  attributes = new Map<string, string>()
  children: MockElement[] = []
  listeners = new Map<string, ((e: any) => void)[]>()
  shadowRoot: MockElement | null = null
  adoptedStyleSheets: any[] = []
  type = ''
  title = ''
  textContent = ''
  disabled = false
  offsetLeft = 0
  offsetTop = 0

  setAttribute(k: string, v: string) { this.attributes.set(k, v) }
  getAttribute(k: string) { return this.attributes.get(k) ?? null }
  attachShadow() {
    this.shadowRoot = new MockElement()
    return this.shadowRoot
  }
  append(...nodes: MockElement[]) {
    this.children.push(...nodes)
  }
  addEventListener(event: string, handler: (e: any) => void) {
    const list = this.listeners.get(event) ?? []
    list.push(handler)
    this.listeners.set(event, list)
  }
  removeEventListener(event: string, handler: (e: any) => void) {
    const list = this.listeners.get(event) ?? []
    this.listeners.set(event, list.filter(h => h !== handler))
  }
  dispatchEvent(event: { type: string; [key: string]: any }) {
    const list = this.listeners.get(event.type) ?? []
    for (const h of list) h(event)
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  hasPointerCapture() { return true }
  click() {
    this.dispatchEvent({ type: 'click', preventDefault: () => {}, stopPropagation: () => {} })
  }
  querySelector(sel: string): MockElement | null {
    if (sel === 'button') {
      return this.children.find(c => c.type === 'button') ?? null
    }
    return null
  }
}

class MockStyleSheet {
  replaceSync() {}
}

describe('koi-pond-toggle component', () => {
  let body: MockElement
  let storage: Map<string, string>

  beforeEach(() => {
    storage = new Map()
    body = new MockElement()
    const elements = new Map<string, MockElement>()

    vi.stubGlobal('CSSStyleSheet', MockStyleSheet)
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
      clear: () => storage.clear(),
    })
    vi.stubGlobal('document', {
      body,
      documentElement: { clientWidth: 1000, clientHeight: 800 },
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: () => {
        const el = new MockElement()
        return el
      },
    })
    vi.stubGlobal('window', {
      innerWidth: 1000,
      innerHeight: 800,
      addEventListener: () => {},
      removeEventListener: () => {},
    })

    // intercept body.append to register #dsh-pond-toggle
    const origAppend = body.append.bind(body)
    body.append = (...nodes: MockElement[]) => {
      for (const node of nodes) {
        if (node.id) elements.set(node.id, node)
      }
      origAppend(...nodes)
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('embeds the custom koi pond toggle image as base64 asset', () => {
    expect(KOI_POND_TOGGLE_ICON).toMatch(/^data:image\/png;base64,/)
  })

  it('installs a draggable floating toggle with custom image and shadow DOM', () => {
    const toggleFn = vi.fn().mockResolvedValue(undefined)
    installKoiPondToggle(toggleFn, false)

    const host = (document as any).getElementById('dsh-pond-toggle')
    expect(host).not.toBeNull()
    expect(host?.shadowRoot).not.toBeNull()

    const button = host?.shadowRoot?.querySelector('button')
    expect(button).not.toBeNull()
    expect(button?.getAttribute('aria-label')).toBe('后院鱼塘')
    expect(button?.getAttribute('aria-pressed')).toBe('false')

    // Calling it again should be idempotent
    installKoiPondToggle(toggleFn, false)
    expect(body.children).toHaveLength(1)
  })

  it('triggers toggle action on click when not dragging', async () => {
    const toggleFn = vi.fn().mockResolvedValue(undefined)
    installKoiPondToggle(toggleFn, false)

    const host = (document as any).getElementById('dsh-pond-toggle')
    const button = host?.shadowRoot?.querySelector('button')
    button?.click()

    expect(toggleFn).toHaveBeenCalledTimes(1)
  })

  it('restores position from localStorage when valid', () => {
    storage.set('dsh-pond-toggle-position', JSON.stringify({ left: 150, top: 200 }))
    const toggleFn = vi.fn().mockResolvedValue(undefined)
    installKoiPondToggle(toggleFn, false)

    const host = (document as any).getElementById('dsh-pond-toggle') as MockElement
    expect(host.style.left).toBe('150px')
    expect(host.style.top).toBe('200px')
  })

  it('supports drag pointer events and updates stored position', () => {
    const toggleFn = vi.fn().mockResolvedValue(undefined)
    installKoiPondToggle(toggleFn, false)

    const host = (document as any).getElementById('dsh-pond-toggle') as MockElement
    const button = host?.shadowRoot?.querySelector('button')

    // Simulate pointerdown
    button?.dispatchEvent({
      type: 'pointerdown',
      button: 0,
      clientX: 500,
      clientY: 500,
      pointerId: 1,
    })

    // Simulate pointermove dragging by dx=50, dy=40
    button?.dispatchEvent({
      type: 'pointermove',
      clientX: 550,
      clientY: 540,
      pointerId: 1,
    })

    // Simulate pointerup
    button?.dispatchEvent({
      type: 'pointerup',
      pointerId: 1,
    })

    expect(storage.get('dsh-pond-toggle-position')).toBeDefined()
    const saved = JSON.parse(storage.get('dsh-pond-toggle-position')!)
    expect(saved.left).toBeGreaterThan(0)
    expect(saved.top).toBeGreaterThan(0)
  })

  it('adjusts tooltip placement between top and bottom based on boundary clearance', () => {
    // Initial position in 800h window with size 56 puts it at top = 800 - 56 - 16 = 728.
    // Space below is 16px (< 48px), so data-placement must be 'top' to prevent bottom clipping.
    const toggleFn = vi.fn().mockResolvedValue(undefined)
    installKoiPondToggle(toggleFn, false)

    const host = (document as any).getElementById('dsh-pond-toggle') as MockElement
    expect(host.getAttribute('data-placement')).toBe('top')

    // Drag to near the top of the window where space below is ample
    const button = host?.shadowRoot?.querySelector('button')
    button?.dispatchEvent({
      type: 'pointerdown',
      button: 0,
      clientX: 500,
      clientY: 728,
      pointerId: 1,
    })
    button?.dispatchEvent({
      type: 'pointermove',
      clientX: 500,
      clientY: 100,
      pointerId: 1,
    })
    button?.dispatchEvent({
      type: 'pointerup',
      pointerId: 1,
    })

    // Now currentTop is near top, space below is abundant (> 48px)
    expect(host.getAttribute('data-placement')).toBe('bottom')
  })
})
