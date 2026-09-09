export function installKoiPondToggle(toggle: () => Promise<void>, inPond = false): void {
  if (document.getElementById('dsh-pond-toggle')) return
  const host = document.createElement('div')
  host.id = 'dsh-pond-toggle'
  Object.assign(host.style, { position: 'fixed', right: '16px', bottom: '16px', width: '44px', height: '44px', zIndex: '2147483647' })
  const shadow = host.attachShadow({ mode: 'open' })
  // Constructed styles work in the isolated preload without weakening page CSP.
  const style = new CSSStyleSheet()
  style.replaceSync(`button{width:44px;height:44px;box-sizing:border-box;border:1px solid #6ea9a1;border-radius:50%;background:#e7f5f0;color:#16534e;box-shadow:0 2px 8px #0003;cursor:pointer;font:24px system-ui;letter-spacing:0;padding:0;-webkit-app-region:no-drag}button:hover{background:#cde9df}button:focus-visible{outline:3px solid #40877f;outline-offset:3px}button:disabled{opacity:.6}span{position:absolute;top:52px;right:0;white-space:nowrap;font:12px system-ui;background:#173e39;color:white;padding:6px 10px;border-radius:4px;display:none}button:hover+span,button:focus-visible+span{display:block}`)
  shadow.adoptedStyleSheets = [style]
  const button = document.createElement('button')
  button.type = 'button'
  const label = inPond ? '切换回对话' : '后院鱼塘'
  button.title = label
  button.setAttribute('aria-label', label)
  button.setAttribute('aria-pressed', String(inPond))
  button.textContent = '\u6c60'
  const tooltip = document.createElement('span')
  tooltip.textContent = label
  button.addEventListener('click', () => {
    tooltip.textContent = label
    button.title = label
    button.disabled = true
    void toggle().catch(() => { tooltip.textContent = '切换失败，请重试'; button.title = tooltip.textContent })
      .finally(() => { button.disabled = false })
  })
  shadow.append(button, tooltip)
  document.body.append(host)
}
