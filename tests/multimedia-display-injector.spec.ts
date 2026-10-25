import { describe, expect, it } from 'vitest'
import {
  detectMediaType,
  enhanceMultimediaElements,
  MULTIMEDIA_STYLES
} from '../src/multimedia-display-injector.ts'

// Minimal DOM mock for Node.js environment
class MockElement {
  tagName: string
  attributes = new Map<string, string>()
  children: MockElement[] = []
  parentNode: MockElement | null = null
  nextSibling: MockElement | null = null
  style: Record<string, string> = {}
  textContent: string = ''
  src: string = ''
  href: string = ''
  alt: string = ''
  controls: boolean = false
  preload: string = ''
  className: string = ''
  id: string = ''
  target: string = ''
  rel: string = ''
  onclick: any = null
  listeners: Record<string, Function[]> = {}

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase()
  }

  getAttribute(name: string) {
    return this.attributes.get(name) || null
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }

  hasAttribute(name: string) {
    return this.attributes.has(name)
  }

  appendChild(child: MockElement) {
    child.parentNode = this
    this.children.push(child)
    return child
  }

  insertBefore(newChild: MockElement, refChild: MockElement | null) {
    newChild.parentNode = this
    const idx = refChild ? this.children.indexOf(refChild) : -1
    if (idx >= 0) {
      this.children.splice(idx, 0, newChild)
    } else {
      this.children.push(newChild)
    }
    return newChild
  }

  remove() {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this)
      if (idx >= 0) this.parentNode.children.splice(idx, 1)
    }
  }

  closest(selector: string) {
    let curr: MockElement | null = this
    while (curr) {
      if (selector === 'a' && curr.tagName === 'A') return curr
      if (selector === 'button' && curr.tagName === 'BUTTON') return curr
      if (selector.includes('role="button"') && curr.getAttribute('role') === 'button') return curr
      if (curr.tagName.toLowerCase() === selector.toLowerCase()) return curr
      curr = curr.parentNode
    }
    return null
  }

  addEventListener(event: string, cb: Function) {
    if (!this.listeners[event]) this.listeners[event] = []
    this.listeners[event].push(cb)
  }

  querySelectorAll(selector: string): any[] {
    const res: any[] = []
    const traverse = (el: MockElement) => {
      for (const c of el.children) {
        if (selector.includes('a[href]') && c.tagName === 'A' && !c.hasAttribute('data-dsh-media-enhanced')) {
          res.push(c)
        }
        if (selector.includes('img') && c.tagName === 'IMG' && !c.hasAttribute('data-dsh-media-lightbox')) {
          res.push(c)
        }
        traverse(c)
      }
    }
    traverse(this)
    return res
  }
}

describe('multimedia-display-injector', () => {
  it('detects audio formats correctly', () => {
    expect(detectMediaType('https://example.com/song.mp3')).toBe('audio')
    expect(detectMediaType('https://example.com/audio.wav?token=123')).toBe('audio')
    expect(detectMediaType('data:audio/mp3;base64,...')).toBe('audio')
  })

  it('detects video formats correctly', () => {
    expect(detectMediaType('https://example.com/clip.mp4')).toBe('video')
    expect(detectMediaType('https://example.com/movie.webm#t=10')).toBe('video')
    expect(detectMediaType('data:video/mp4;base64,...')).toBe('video')
  })

  it('detects image formats correctly', () => {
    expect(detectMediaType('https://example.com/pic.png')).toBe('image')
    expect(detectMediaType('https://example.com/photo.jpeg')).toBe('image')
    expect(detectMediaType('data:image/png;base64,...')).toBe('image')
  })

  it('detects unknown media formats', () => {
    expect(detectMediaType('https://example.com/document.pdf')).toBe('unknown')
    expect(detectMediaType('')).toBe('unknown')
  })

  it('enhances audio link into media card idempotently', () => {
    const origDocument = (globalThis as any).document
    try {
      const mockDoc: any = {
        createElement: (tag: string) => new MockElement(tag),
        getElementById: () => null,
        body: new MockElement('body'),
        documentElement: new MockElement('html')
      }
      ;(globalThis as any).document = mockDoc

      const container = new MockElement('div')
      const link = new MockElement('a')
      link.href = 'https://example.com/song.mp3'
      link.setAttribute('href', 'https://example.com/song.mp3')
      link.textContent = 'Play Song'
      container.appendChild(link)

      const first = enhanceMultimediaElements(container as any)
      expect(first).toBe(1)
      expect(link.getAttribute('data-dsh-media-enhanced')).toBe('true')

      const second = enhanceMultimediaElements(container as any)
      expect(second).toBe(0) // Idempotent!
    } finally {
      ;(globalThis as any).document = origDocument
    }
  })

  it('provides non-empty CSS styles for injection', () => {
    expect(MULTIMEDIA_STYLES).toContain('.dsh-multimedia-card')
    expect(MULTIMEDIA_STYLES).toContain('.dsh-lightbox-overlay')
  })

  it('ignores images inside button or role=button (e.g. explorer toolbar button)', () => {
    const origDocument = (globalThis as any).document
    try {
      const mockDoc: any = {
        createElement: (tag: string) => new MockElement(tag),
        getElementById: () => null,
        body: new MockElement('body'),
        documentElement: new MockElement('html')
      }
      ;(globalThis as any).document = mockDoc

      const container = new MockElement('div')

      // Button containing an app icon img
      const btn = new MockElement('button')
      const btnImg = new MockElement('img')
      btnImg.src = 'https://example.com/icon.png'
      btnImg.setAttribute('src', 'https://example.com/icon.png')
      btn.appendChild(btnImg)
      container.appendChild(btn)

      // Div with role="button" containing an img
      const roleBtn = new MockElement('div')
      roleBtn.setAttribute('role', 'button')
      const roleBtnImg = new MockElement('img')
      roleBtnImg.src = 'https://example.com/folder.png'
      roleBtnImg.setAttribute('src', 'https://example.com/folder.png')
      roleBtn.appendChild(roleBtnImg)
      container.appendChild(roleBtn)

      // Ordinary content img (e.g. in markdown chat)
      const normalImg = new MockElement('img')
      normalImg.src = 'https://example.com/chat-image.png'
      normalImg.setAttribute('src', 'https://example.com/chat-image.png')
      container.appendChild(normalImg)

      const count = enhanceMultimediaElements(container as any)
      // Only normalImg should be enhanced with zoom-in cursor / lightbox
      expect(count).toBe(1)
      expect(normalImg.style.cursor).toBe('zoom-in')
      expect(btnImg.style.cursor).toBeUndefined()
      expect(roleBtnImg.style.cursor).toBeUndefined()
    } finally {
      ;(globalThis as any).document = origDocument
    }
  })
})
