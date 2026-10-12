export type MediaType = 'audio' | 'video' | 'image' | 'unknown'

export const AUDIO_EXT_REGEX = /\.(mp3|wav|ogg|m4a|aac|flac)(\?[^#]*)?(#.*)?$/i
export const VIDEO_EXT_REGEX = /\.(mp4|webm|mov|m4v|mkv|ogv)(\?[^#]*)?(#.*)?$/i
export const IMAGE_EXT_REGEX = /\.(png|jpe?g|gif|webp|svg|bmp)(\?[^#]*)?(#.*)?$/i

export function detectMediaType(src: string): MediaType {
  const url = (src || '').trim()
  if (!url) return 'unknown'
  if (url.startsWith('data:audio/')) return 'audio'
  if (url.startsWith('data:video/')) return 'video'
  if (url.startsWith('data:image/')) return 'image'
  if (AUDIO_EXT_REGEX.test(url)) return 'audio'
  if (VIDEO_EXT_REGEX.test(url)) return 'video'
  if (IMAGE_EXT_REGEX.test(url)) return 'image'
  return 'unknown'
}

export function enhanceMultimediaElements(container: HTMLElement | Document = document): number {
  let count = 0

  // 限制扫描范围或全局目标
  const isHtmlElement = typeof HTMLElement !== 'undefined' && container instanceof HTMLElement
  const root = isHtmlElement ? container : (container as any).body || (container as any).documentElement || (container as any)
  if (!root) return 0

  // 1. 查找超链接，如果是音视频格式则转换为内嵌播放卡片（避免重复处理）
  const linkList = root.querySelectorAll ? Array.from(root.querySelectorAll('a[href]:not([data-dsh-media-enhanced])')) : []
  linkList.forEach((el: any) => {
    const a = el as HTMLAnchorElement
    const href = a.getAttribute('href') || ''
    const mediaType = detectMediaType(href)
    if (mediaType === 'audio' || mediaType === 'video') {
      a.setAttribute('data-dsh-media-enhanced', 'true')
      const card = document.createElement('div')
      card.className = 'dsh-multimedia-card'
      card.setAttribute('data-media-type', mediaType)

      const header = document.createElement('div')
      header.className = 'dsh-multimedia-header'
      header.textContent = mediaType === 'audio' ? '🎵 音频播放' : '🎬 视频播放'

      let player: HTMLElement
      if (mediaType === 'audio') {
        const audio = document.createElement('audio')
        audio.controls = true
        audio.preload = 'metadata'
        audio.src = href
        player = audio
      } else {
        const video = document.createElement('video')
        video.controls = true
        video.preload = 'metadata'
        video.src = href
        player = video
      }
      player.className = 'dsh-multimedia-player'

      const footer = document.createElement('div')
      footer.className = 'dsh-multimedia-footer'
      const originalLink = document.createElement('a')
      originalLink.href = href
      originalLink.target = '_blank'
      originalLink.rel = 'noreferrer noopener'
      originalLink.textContent = a.textContent?.trim() || '打开原始媒体链接'
      footer.appendChild(originalLink)

      card.appendChild(header)
      card.appendChild(player)
      card.appendChild(footer)

      if (a.parentNode) {
        a.parentNode.insertBefore(card, a.nextSibling)
      }
      count++
    }
  })

  // 2. 增强图片展示：支持点击灯箱放大预览（排除 a 标签包裹的大图或小于等于24px的微缩图标/头像）
  const imageList = root.querySelectorAll ? Array.from(root.querySelectorAll('img:not([data-dsh-media-lightbox])')) : []
  imageList.forEach((el: any) => {
    const img = el as HTMLImageElement
    img.setAttribute('data-dsh-media-lightbox', 'processed')
    // 排除特定微缩图标或未加载图
    if (img.closest && img.closest('a') !== null) return

    img.style.cursor = 'zoom-in'
    img.addEventListener('click', (e: any) => {
      e?.stopPropagation?.()
      showImageLightbox(img.src, img.alt)
    })
    count++
  })

  return count
}

export function showImageLightbox(src: string, alt: string): HTMLElement {
  const existing = document.getElementById('dsh-media-lightbox-overlay')
  if (existing) existing.remove()

  const overlay = document.createElement('div')
  overlay.id = 'dsh-media-lightbox-overlay'
  overlay.className = 'dsh-lightbox-overlay'

  const img = document.createElement('img')
  img.src = src
  img.alt = alt || 'Preview'
  img.className = 'dsh-lightbox-img'

  const toolbar = document.createElement('div')
  toolbar.className = 'dsh-lightbox-toolbar'

  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.textContent = '复制链接'
  copyBtn.className = 'dsh-lightbox-btn'
  copyBtn.onclick = (e) => {
    e.stopPropagation()
    navigator.clipboard?.writeText(src)
    copyBtn.textContent = '已复制！'
    setTimeout(() => { copyBtn.textContent = '复制链接' }, 1500)
  }

  const openBtn = document.createElement('button')
  openBtn.type = 'button'
  openBtn.textContent = '新窗口打开'
  openBtn.className = 'dsh-lightbox-btn'
  openBtn.onclick = (e) => {
    e.stopPropagation()
    window.open(src, '_blank')
  }

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.textContent = '关闭 (ESC)'
  closeBtn.className = 'dsh-lightbox-btn dsh-lightbox-close'
  closeBtn.onclick = () => overlay.remove()

  toolbar.appendChild(copyBtn)
  toolbar.appendChild(openBtn)
  toolbar.appendChild(closeBtn)

  overlay.appendChild(img)
  overlay.appendChild(toolbar)

  overlay.onclick = () => overlay.remove()
  img.onclick = (e) => e.stopPropagation()

  const keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      overlay.remove()
      document.removeEventListener('keydown', keyHandler)
    }
  }
  document.addEventListener('keydown', keyHandler)

  document.body.appendChild(overlay)
  return overlay
}

export const MULTIMEDIA_STYLES = `
.dsh-multimedia-card {
  margin: 10px 0;
  padding: 12px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.05));
  border: 1px solid var(--dsw-alias-stroke-primary, rgba(0, 0, 0, 0.1));
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 100%;
}
.dsh-multimedia-header {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, #666);
}
.dsh-multimedia-player {
  width: 100%;
  max-width: 600px;
  border-radius: 8px;
  outline: none;
}
.dsh-multimedia-footer {
  font-size: 12px;
  opacity: 0.8;
}
.dsh-lightbox-overlay {
  position: fixed;
  inset: 0;
  z-index: 999999;
  background: rgba(0, 0, 0, 0.75);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(4px);
  padding: 24px;
}
.dsh-lightbox-img {
  max-width: 90vw;
  max-height: 80vh;
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
}
.dsh-lightbox-toolbar {
  margin-top: 16px;
  display: flex;
  gap: 12px;
}
.dsh-lightbox-btn {
  padding: 6px 14px;
  border-radius: 6px;
  border: none;
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.dsh-lightbox-btn:hover {
  background: rgba(255, 255, 255, 0.35);
}
`

export function installMultimediaDisplayHook(cssStyles: string = MULTIMEDIA_STYLES): void {
  const globalObject = globalThis as any
  if (globalObject.__dshDesktopMultimediaDisplayHookInstalled) return
  globalObject.__dshDesktopMultimediaDisplayHookInstalled = true

  const styleEl = document.createElement('style')
  styleEl.textContent = cssStyles
  document.head.appendChild(styleEl)

  // 监听 DOM 树变化并增强元素
  const observer = new MutationObserver(() => {
    enhanceMultimediaElements()
  })

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true
  })

  enhanceMultimediaElements()
}
