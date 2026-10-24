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

export function enhanceMultimediaElements(container?: any): number {
  if (typeof document === 'undefined') return 0
  const root = container || document.body || document.documentElement
  if (!root) return 0

  let count = 0
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

      let player: any
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

  const imageList = root.querySelectorAll ? Array.from(root.querySelectorAll('img:not([data-dsh-media-lightbox])')) : []
  imageList.forEach((el: any) => {
    const img = el as HTMLImageElement
    img.setAttribute('data-dsh-media-lightbox', 'processed')
    const src = img.getAttribute('src') || ''
    const mediaType = detectMediaType(src)
    if (mediaType === 'video') {
      const card = document.createElement('div')
      card.className = 'dsh-multimedia-card'
      card.setAttribute('data-media-type', 'video')
      const header = document.createElement('div')
      header.className = 'dsh-multimedia-header'
      header.textContent = '🎬 视频播放'
      const video = document.createElement('video')
      video.controls = true
      video.preload = 'metadata'
      video.src = src
      video.className = 'dsh-multimedia-player'
      const footer = document.createElement('div')
      footer.className = 'dsh-multimedia-footer'
      const originalLink = document.createElement('a')
      originalLink.href = src
      originalLink.target = '_blank'
      originalLink.rel = 'noreferrer noopener'
      originalLink.textContent = img.alt?.trim() || '打开原始视频链接'
      footer.appendChild(originalLink)
      card.appendChild(header)
      card.appendChild(video)
      card.appendChild(footer)
      if (img.parentNode) {
        img.parentNode.insertBefore(card, img)
        img.style.display = 'none'
      }
      count++
      return
    }
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

export function showImageLightbox(src: string, alt: string): HTMLElement | null {
  if (typeof document === 'undefined') return null
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

  if (document.body) {
    document.body.appendChild(overlay)
  }
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

export const INSTALL_MULTIMEDIA_DISPLAY_SOURCE = `(function () {
  const globalObject = globalThis;
  if (globalObject.__dshDesktopMultimediaDisplayHookInstalled) return;
  globalObject.__dshDesktopMultimediaDisplayHookInstalled = true;

  const AUDIO_EXT_REGEX = /\\.(mp3|wav|ogg|m4a|aac|flac)(\\?[^#]*)?(#.*)?$/i;
  const VIDEO_EXT_REGEX = /\\.(mp4|webm|mov|m4v|mkv|ogv)(\\?[^#]*)?(#.*)?$/i;
  const IMAGE_EXT_REGEX = /\\.(png|jpe?g|gif|webp|svg|bmp)(\\?[^#]*)?(#.*)?$/i;

  function detectMediaType(src) {
    const url = (src || '').trim();
    if (!url) return 'unknown';
    if (url.startsWith('data:audio/')) return 'audio';
    if (url.startsWith('data:video/')) return 'video';
    if (url.startsWith('data:image/')) return 'image';
    if (AUDIO_EXT_REGEX.test(url)) return 'audio';
    if (VIDEO_EXT_REGEX.test(url)) return 'video';
    if (IMAGE_EXT_REGEX.test(url)) return 'image';
    return 'unknown';
  }

  function showImageLightbox(src, alt) {
    const existing = document.getElementById('dsh-media-lightbox-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'dsh-media-lightbox-overlay';
    overlay.className = 'dsh-lightbox-overlay';

    const img = document.createElement('img');
    img.src = src;
    img.alt = alt || 'Preview';
    img.className = 'dsh-lightbox-img';

    const toolbar = document.createElement('div');
    toolbar.className = 'dsh-lightbox-toolbar';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = '复制链接';
    copyBtn.className = 'dsh-lightbox-btn';
    copyBtn.onclick = (e) => {
      e.stopPropagation();
      navigator.clipboard?.writeText(src);
      copyBtn.textContent = '已复制！';
      setTimeout(() => { copyBtn.textContent = '复制链接'; }, 1500);
    };

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.textContent = '新窗口打开';
    openBtn.className = 'dsh-lightbox-btn';
    openBtn.onclick = (e) => {
      e.stopPropagation();
      window.open(src, '_blank');
    };

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '关闭 (ESC)';
    closeBtn.className = 'dsh-lightbox-btn dsh-lightbox-close';
    closeBtn.onclick = () => overlay.remove();

    toolbar.appendChild(copyBtn);
    toolbar.appendChild(openBtn);
    toolbar.appendChild(closeBtn);

    overlay.appendChild(img);
    overlay.appendChild(toolbar);

    overlay.onclick = () => overlay.remove();
    img.onclick = (e) => e.stopPropagation();

    const keyHandler = (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', keyHandler);
      }
    };
    document.addEventListener('keydown', keyHandler);

    if (document.body) document.body.appendChild(overlay);
  }

  // 处理中标志：本函数会写 DOM（insertBefore），若不加闸会与 MutationObserver
  // 形成自我激发的指数级回扫。长会话历史里有成百上千个链接时表现为彻底卡死。
  let enhancing = false;
  let enhanceScheduled = false;

  function enhanceMultimediaElements(container) {
    if (enhancing) return;
    const root = container || document.body || document.documentElement;
    if (!root) return;
    enhancing = true;
    try {

    const linkList = root.querySelectorAll ? Array.from(root.querySelectorAll('a[href]:not([data-dsh-media-enhanced])')) : [];
    linkList.forEach((a) => {
      // 无论是否为媒体链接都打标记，避免下一轮重复扫描同一批节点。
      a.setAttribute('data-dsh-media-enhanced', 'true');
      const href = a.getAttribute('href') || '';
      const mediaType = detectMediaType(href);
      if (mediaType === 'audio' || mediaType === 'video') {
        const card = document.createElement('div');
        card.className = 'dsh-multimedia-card';
        card.setAttribute('data-media-type', mediaType);

        const header = document.createElement('div');
        header.className = 'dsh-multimedia-header';
        header.textContent = mediaType === 'audio' ? '🎵 音频播放' : '🎬 视频播放';

        const player = document.createElement(mediaType);
        player.controls = true;
        player.preload = 'metadata';
        player.src = href;
        player.className = 'dsh-multimedia-player';

        const footer = document.createElement('div');
        footer.className = 'dsh-multimedia-footer';
        const originalLink = document.createElement('a');
        originalLink.href = href;
        originalLink.target = '_blank';
        originalLink.rel = 'noreferrer noopener';
        originalLink.textContent = a.textContent?.trim() || '打开原始媒体链接';
        // 必须打标记：否则下一轮扫描会把卡片里的这个链接再次识别为媒体链接并再套一层卡片，无限增长。
        originalLink.setAttribute('data-dsh-media-enhanced', 'true');
        footer.appendChild(originalLink);

        card.appendChild(header);
        card.appendChild(player);
        card.appendChild(footer);

        if (a.parentNode) {
          a.parentNode.insertBefore(card, a.nextSibling);
        }
      }
    });

    const imageList = root.querySelectorAll ? Array.from(root.querySelectorAll('img:not([data-dsh-media-lightbox])')) : [];
    imageList.forEach((img) => {
      img.setAttribute('data-dsh-media-lightbox', 'processed');
      const src = img.getAttribute('src') || '';
      const mediaType = detectMediaType(src);
      if (mediaType === 'video') {
        const card = document.createElement('div');
        card.className = 'dsh-multimedia-card';
        card.setAttribute('data-media-type', 'video');
        const header = document.createElement('div');
        header.className = 'dsh-multimedia-header';
        header.textContent = '🎬 视频播放';
        const video = document.createElement('video');
        video.controls = true;
        video.preload = 'metadata';
        video.src = src;
        video.className = 'dsh-multimedia-player';
        const footer = document.createElement('div');
        footer.className = 'dsh-multimedia-footer';
        const originalLink = document.createElement('a');
        originalLink.href = src;
        originalLink.target = '_blank';
        originalLink.rel = 'noreferrer noopener';
        originalLink.textContent = img.alt?.trim() || '打开原始视频链接';
        originalLink.setAttribute('data-dsh-media-enhanced', 'true');
        footer.appendChild(originalLink);
        card.appendChild(header);
        card.appendChild(video);
        card.appendChild(footer);
        if (img.parentNode) {
          img.parentNode.insertBefore(card, img);
          img.style.display = 'none';
        }
        return;
      }
      if (img.closest && img.closest('a') !== null) return;
      img.style.cursor = 'zoom-in';
      img.addEventListener('click', (e) => {
        e?.stopPropagation?.();
        showImageLightbox(img.src, img.alt);
      });
    });
    } finally {
      enhancing = false;
    }
  }

  const init = () => {
    const targetHead = document.head || document.getElementsByTagName('head')[0] || document.documentElement;
    if (targetHead && !document.getElementById('dsh-multimedia-display-style')) {
      const styleEl = document.createElement('style');
      styleEl.id = 'dsh-multimedia-display-style';
      styleEl.textContent = ` + JSON.stringify(MULTIMEDIA_STYLES) + `;
      targetHead.appendChild(styleEl);
    }

    const targetBody = document.body || document.documentElement;
    if (targetBody) {
      // 关键修复：MutationObserver 必须合并成一次空闲扫描。
      // 原实现每批变更都全量 querySelectorAll 两遍，而处理过程本身又写 DOM，
      // 在长会话历史（成百上千个链接）下形成指数级回扫，表现为界面彻底卡死。
      const observer = new MutationObserver(() => {
        if (enhanceScheduled) return;
        enhanceScheduled = true;
        const run = () => {
          enhanceScheduled = false;
          enhanceMultimediaElements(targetBody);
        };
        if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1000 });
        else setTimeout(run, 200);
      });
      observer.observe(targetBody, {
        childList: true,
        subtree: true
      });
      enhanceMultimediaElements(targetBody);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})()`

export function installMultimediaDisplayHook(scriptSource: string = INSTALL_MULTIMEDIA_DISPLAY_SOURCE): void {
  try {
    Function(scriptSource)()
  } catch (err) {
    console.error('桌面壳多媒体内容展示与播放注入失败', err)
  }
}
