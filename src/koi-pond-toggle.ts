export function installKoiPondToggle(toggle: () => Promise<void>, inPond = false): void {
  if (document.getElementById('dsh-pond-toggle')) return
  const host = document.createElement('div')
  host.id = 'dsh-pond-toggle'
  Object.assign(host.style, { position: 'fixed', right: '16px', bottom: '16px', width: '44px', height: '44px', zIndex: '2147483647' })
  const shadow = host.attachShadow({ mode: 'open' })
  // Constructed styles work in the isolated preload without weakening page CSP.
  const style = new CSSStyleSheet()
  style.replaceSync(`button{display:grid;place-items:center;width:44px;height:44px;box-sizing:border-box;border:1px solid #6ea9a1;border-radius:50%;background:#e7f5f0;color:#16534e;box-shadow:0 2px 8px #0003;cursor:pointer;padding:0;-webkit-app-region:no-drag}button:hover{background:#cde9df}button:focus-visible{outline:3px solid #40877f;outline-offset:3px}button:disabled{opacity:.6}svg{display:block;width:27px;height:27px}span{position:absolute;top:52px;right:0;white-space:nowrap;font:12px system-ui;background:#173e39;color:white;padding:6px 10px;border-radius:4px;display:none}button:hover+span,button:focus-visible+span{display:block}`)
  shadow.adoptedStyleSheets = [style]
  const button = document.createElement('button')
  button.type = 'button'
  const label = inPond ? '切换回对话' : '后院鱼塘'
  button.title = label
  button.setAttribute('aria-label', label)
  button.setAttribute('aria-pressed', String(inPond))
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10" fill="#bfe5dc"/><path d="M4 14c2.2-2 4.4-2 6.6 0s4.4 2 6.6 0 2.8-2 3.8-1.1" fill="none" stroke="#277b70" stroke-linecap="round" stroke-width="1.4"/><path d="M5.5 10.1c1.7-2.1 4.7-2.5 6.9-1.1l1.4.9-1.6 1.8c-1.7 1.8-4.6 1.8-6.3 0z" fill="#f28b52" stroke="#a85239" stroke-width=".7"/><path d="m8.3 9.7 1.2 1.3M6.4 10.7l1.5-.4" fill="none" stroke="#fff4dd" stroke-linecap="round" stroke-width=".8"/><circle cx="10.9" cy="9.6" r=".55" fill="#173e39"/><path d="M16.7 6.1v2.4M15.5 7.3h2.4" stroke="#d7a844" stroke-linecap="round" stroke-width="1"/></svg>'
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
