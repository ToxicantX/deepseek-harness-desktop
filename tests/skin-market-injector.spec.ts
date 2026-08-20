import { describe, expect, it } from 'vitest'
import { createClientBundleAdapterScript, createSkinDisposerScript, createSkinMarketInjectorScript } from '../src/skin-market-injector.ts'

describe('shell-owned skin marketplace injector', () => {
  it('renders an idempotent icon-only marketplace using preload API', () => {
    const script=createSkinMarketInjectorScript()
    expect(script).toContain("const ROOT_ID = 'dsh-shell-skin-market'")
    expect(script).toContain('window.dshDesktopSkins')
    for(const method of ['api.list()','api.install(skin.id)','api.activate(skin.id)','api.deactivate()','api.uninstall(skin.id)']) expect(script).toContain(method)
    expect(script).toContain('api.preview(skin.id,index)')
    expect(script).toContain('IntersectionObserver')
    expect(script).toContain('image.src = trustedDataUrl')
    expect(script).toContain("image.loading='lazy'")
    expect(script).toContain("image.addEventListener('error',()=>image.remove())")
    expect(script).not.toMatch(/image\.src\s*=\s*screenshot/)
    expect(script).toContain('skin.screenshots')
    expect(script).toContain("image.loading='lazy'")
    expect(script).toContain("fallback.textContent='暂无预览图'")
    expect(script).not.toContain('conic-gradient(')
    expect(() => new Function(script)).not.toThrow()
    expect(script).toContain('window.__dshDesktopSkinRuntime')
    expect(script).toContain('availableThemes')
    expect(script).toContain('选择主题风格')
    expect(script).toContain('selectTheme')
    expect(script).not.toContain('selectVariant')
    expect(script).not.toContain('zhijun-dai.catppuccin')
    expect(script).not.toContain('caoyiwei850.dsh-client-ui-skins')
    expect(script).toContain('height:455px')
    expect(script).toContain('position:absolute')
    expect(script).toContain('bottom:14px')
    expect(script).toContain('padding:14px 14px 62px')
    expect(script).not.toMatch(/fetch\s*\(/)
    expect(script).not.toContain('/dsh-skin-market')
    expect(script).not.toMatch(/innerHTML/)
    expect(script).not.toMatch(/eval\s*\(/)
  })

  it('opens the market through a renderer-owned function with no floating toggle', () => {
    const script = createSkinMarketInjectorScript()

    expect(script).toContain("Object.defineProperty(window,'__dshDesktopOpenSkinMarket'")
    expect(script).not.toContain('dss-toggle')
    expect(script).not.toContain('swatchbook')
    expect(script).not.toContain("aria-label','打开皮肤市场")
    expect(script).toContain('left:50%!important;top:50%!important')
    expect(script).toContain('transform:translate(-50%,-50%)!important')
    expect(script).not.toContain('right:22px!important;bottom:82px!important')
  })

  it('uses DSH theme custom properties and gates settings toggle on rendered content', () => {
    const marketScript = createSkinMarketInjectorScript()
    const adapterScript = createClientBundleAdapterScript("window.__ModuleLoader__.load({ id: 'fixture', factory: () => ({ apply() {} }) })", 'fixture-skin')

    expect(marketScript).not.toMatch(/color-scheme\s*:/)
    expect(marketScript).toContain("readThemeToken(['--dsw-alias-bg-layer-1'")
    expect(marketScript).toContain("root.style.setProperty('--dss-surface',surface)")
    expect(adapterScript).toContain("width:'38px',height:'38px',boxSizing:'border-box',display:'none'")
    expect(adapterScript).toContain('const settingsObserver=new MutationObserver(updateSettingsVisibility)')
    expect(adapterScript).toContain("const hasContent=mounts.some(mount=>mount.childElementCount>0||(mount.textContent||'').trim().length>0)")
    expect(adapterScript).toContain("settingsToggle.style.display=hasContent?'grid':'none'")
  })

  it('adapts a reviewed ModuleLoader client and collects disposers', () => {
    const bundle="window.__ModuleLoader__.load({ id: 'fixture', factory: () => ({ apply(ctx) { ctx.effect(() => () => {}); } }) }); // exports.apply = apply"
    const script=createClientBundleAdapterScript(bundle,'skin-id')
    expect(script).toContain('window.__ModuleLoader__ = { load(definition)')
    expect(script).toContain('exported.apply(context)')
    expect(script).toContain("const registryKey = '__dshDesktopSkinRuntime'")
    expect(script).toContain('disposers[index]()')
    expect(script).toContain('"skin-id"')
    expect(script).toContain('const availableThemes = [...registeredThemes.values()].map')
    expect(script).toContain('availableThemes, selectedTheme, supportsCustomBackground')
    expect(script).toContain('selectTheme(themeId)')
    expect(script).toContain('shellThemeStorageKey')
    expect(script).toContain('const createSnapshotStore =')
    expect(script).toContain('createSnapshotStore: platform.createSnapshotStore || createSnapshotStore')
  })

  it('uses DSH React for visible slots and owns complete lifecycle cleanup', () => {
    const bundle = "window.__ModuleLoader__.load({ id: 'fixture', factory: require => { const React = require('react'); return { apply(ctx) { React.memo(() => null); ctx.locale.getLocale(); ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', inject: () => ({}) }, () => null)); document.documentElement.setAttribute('data-sd-stardew', ''); return () => {}; } } } })"
    const script = createClientBundleAdapterScript(bundle, 'leemancheung.dsh-whale-companion')

    expect(() => new Function(script)).not.toThrow()
    expect(script).toContain('(async () => {')
    expect(script).toContain('window.__DSH_MODULES__')
    expect(script).toContain('window.__dshDesktopReactRuntime')
    expect(script).toContain("await loadReal('react'")
    expect(script).toContain("const propName='use'+hookName.charAt(0).toUpperCase()+hookName.slice(1)")
    expect(script).toContain('props.useSession ||= makeStoreHook(null,emptySession)')
    expect(script).toContain("config.store.create('dsh-desktop-shell')")
    expect(script).toContain("await loadReal('react/jsx-runtime'")
    expect(script).toContain("await loadReal('react-dom/client'")
    expect(script).toContain('reactDomClient.createRoot')
    expect(script).toContain("name === 'shell.overlay'")
    expect(script).toContain("name === 'conversation.view'")
    expect(script).toContain("name === 'sidebar.footer.action'")
    expect(script).toContain("String(name).startsWith('settings.')")
    expect(script).not.toContain("settingsToggle.textContent='插件设置'")
    expect(script).toContain("settingsToggle.setAttribute('aria-label','插件设置')")
    expect(script).toContain("settingsIcon.setAttribute('data-icon','settings')")
    expect(script).toContain("settingsCircle.setAttribute('r','3')")
    expect(script).toContain("setAttribute('data-dsh-skin-owned'")
    expect(script).toContain('root.unmount')
    expect(script).toContain('getLocale: () => ({ active: activeLocale })')
    expect(script).toContain('const applyResult = await exported.apply(context)')
    expect(script).toContain("querySelectorAll('style,link[rel=\"stylesheet\"]')")
    expect(script).toContain('changedHtmlAttrs')
    expect(script).toContain('changedBodyAttrs')
    expect(script).toContain("name === 'remote.whaleCompanion'")
    expect(script).toContain("localStorage.setItem('dsh-desktop.whale-companion'")
    expect(script).toContain('async get(){return {ok:true,value:whaleState}}')
  })

  it('exposes generic registered themes and persists runtime selection', () => {
    const bundle="window.__ModuleLoader__.load({ id: 'fixture', factory: () => ({ apply() {} }) })"
    const script=createClientBundleAdapterScript(bundle,'fixture-skin')
    expect(script).toContain('const availableThemes = [...registeredThemes.values()].map')
    expect(script).toContain('availableThemes, selectedTheme, supportsCustomBackground')
    expect(script).toContain('selectTheme(themeId)')
    expect(script).toContain('shellThemeStorageKey')
    expect(script).toContain('localStorage.getItem(shellThemeStorageKey)')
    expect(script).toContain('localStorage.setItem(shellThemeStorageKey')
    expect(script).toContain('const diagnostics = { before: beforeMetrics, after: afterMetrics')
  })

  it('rewrites package-local visual assets to the safe skin protocol', () => {
    const bundle="window.__ModuleLoader__.load({ id: 'fixture', factory: () => ({ apply() { const css = \"url('/aemeath-skin/wallpaper.jpg')\" } }) })"
    const script=createClientBundleAdapterScript(bundle,'fixture-skin')
    expect(script).toContain('dsh-skin://fixture-skin/aemeath-skin/wallpaper.jpg')
    expect(script).toContain('body{background-color:transparent!important;background-image:url')
    expect(script).toContain('data-dsh-skin-background-fix')
  })

  it('makes app surfaces translucent for package-image backgrounds', () => {
    const bundle="window.__ModuleLoader__.load({ id: 'fixture', factory: () => ({ apply() { const css = \"url('/aemeath-skin/wallpaper.jpg')\" } }) })"
    const script=createClientBundleAdapterScript(bundle,'fixture-skin')

    expect(script).toMatch(/--dsw-alias-bg-base:rgba\([^)]*\)!important/)
    expect(script).toMatch(/--dsw-alias-bg-layer-1:rgba\([^)]*\)!important/)
    expect(script).toMatch(/--dsw-alias-bg-layer-2:rgba\([^)]*\)!important/)
  })

  it('exposes global shell-owned wallpaper support for every theme', () => {
    const bundle = "window.__ModuleLoader__.load({ id: 'fixture', factory: () => ({ apply() {} }) })"
    const script = createClientBundleAdapterScript(bundle, 'slot-wallpaper-skin')

    expect(script).toContain('const supportsCustomBackground = true')
    expect(script).toContain('setCustomBackground(dataUrl)')
    expect(script).toContain('clearCustomBackground()')
    expect(script).toContain('dsh-desktop.skin-background.global')
    expect(script).toContain('legacyCustomBackgroundStorageKey')
    expect(script).toContain('customBackgroundUrl || backgroundAssetUrl')
    expect(script).toContain('localStorage.getItem')
    expect(script).toContain('localStorage.setItem')
    expect(() => new Function(script)).not.toThrow()
    expect(script).toMatch(/--dsw-alias-bg-base:rgba\([^)]*\)!important/)
    expect(script).toMatch(/--dsw-alias-bg-layer-1:rgba\([^)]*\)!important/)
    expect(script).toMatch(/--dsw-alias-bg-layer-2:rgba\([^)]*\)!important/)
  })

  it('renders permanent safe wallpaper controls independent of active themes', () => {
    const script = createSkinMarketInjectorScript()

    expect(script).toContain('选择背景图片')
    expect(script).toContain('移除背景')
    expect(script).toContain("type='file'")
    expect(script).toContain('FileReader')
    expect(script).toContain('new Image')
    expect(script).toContain('canvas')
    expect(script).toContain('runtime.setCustomBackground')
    expect(script).toContain('globalBackgroundStorageKey')
    expect(script).toContain('panel.append(head,status,wallpaperControls,grid)')
    expect(script).not.toContain('backgroundControls')
    expect(script).not.toContain('supportsCustomBackground&&')
    expect(script).not.toMatch(/\binnerHTML\b/)
    expect(script).not.toMatch(/eval\s*\(/)
  })

  it('rejects unsupported client bundles and emits a disposer', () => {
    expect(()=>createClientBundleAdapterScript('alert(1)','bad')).toThrow('unsupported skin client bundle')
    const dispose=createSkinDisposerScript()
    expect(dispose).toContain('__dshDesktopSkinRuntime')
    expect(dispose).toContain('runtime.dispose()')
  })
})
