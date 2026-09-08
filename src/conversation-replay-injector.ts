// @ts-nocheck

export function runIsolatedShellInjection(label: string, callback: () => unknown): boolean {
  try {
    const result = callback()
    if (result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(result).catch(error => { console.error(label, error) })
    }
    return true
  } catch (error) {
    console.error(label, error)
    return false
  }
}

export function installConversationReplayModuleHook(): string {
  const globalObject = globalThis
  const hookKey = '__dshDesktopConversationReplayHook'
  const targetModuleId = '@deepseek-ai/dsh-client-ui-conversation'
  const legacyModuleId = '@deepseek-ai/dsh-desktop-conversation-replay'
  const moduleFactoryTransforms = new Map()
  const existingHook = globalObject[hookKey]
  if (existingHook?.version === 1) {
    if (typeof existingHook.ensureLoaderAccessor === 'function') {
      try { existingHook.ensureLoaderAccessor() }
      catch (error) { console.error('桌面壳 ModuleLoader 接管恢复失败', error) }
    }
    return 'already-installed'
  }

  function createConversationReplayFeature(require) {
    const reactModule = require('react')
    const React = typeof reactModule?.createElement === 'function' ? reactModule : reactModule?.default
    if (typeof React?.createElement !== 'function') throw new Error('React runtime is unavailable')
    const optionalRequire = id => {
      try { return require(id) }
      catch { return undefined }
    }
    const moduleMember = (module, name) => module?.[name] ?? module?.default?.[name]
    const isComponent = value => typeof value === 'function'
      || typeof value === 'string'
      || typeof value === 'symbol'
      || (value !== null && typeof value === 'object' && value.$$typeof !== undefined)
    const componentOr = (value, fallback) => isComponent(value) ? value : fallback
    const primitives = optionalRequire('@deepseek-ai/dsh-client-ui-primitives')
    const attachment = optionalRequire('@deepseek-ai/dsh-client-ui-attachment')
    const FallbackTooltip = ({ children }) => children ?? null
    const FallbackMessageText = ({ text }) => React.createElement('span', null, text)
    const FallbackJsonBlock = ({ payload }) => React.createElement('pre', null, JSON.stringify(payload, null, 2))
    const fallbackIcon = text => function FallbackIcon() {
      return React.createElement('span', { 'aria-hidden': true }, text)
    }
    const IconCheckOutline16 = componentOr(moduleMember(primitives, 'IconCheckOutline16'), fallbackIcon('✓'))
    const IconCopyOutline16 = componentOr(moduleMember(primitives, 'IconCopyOutline16'), fallbackIcon('⧉'))
    const IconEditOutline16 = componentOr(moduleMember(primitives, 'IconEditOutline16'), fallbackIcon('✎'))
    const IconRefreshOutline16 = componentOr(moduleMember(primitives, 'IconRefreshOutline16'), fallbackIcon('↻'))
    const ImageGallery = componentOr(moduleMember(attachment, 'ImageGallery'), undefined)
    const JsonBlock = componentOr(moduleMember(primitives, 'JsonBlock'), FallbackJsonBlock)
    const MessageText = componentOr(moduleMember(primitives, 'MessageText'), FallbackMessageText)
    const Tooltip = componentOr(moduleMember(primitives, 'Tooltip'), FallbackTooltip)
    const writeClipboard = moduleMember(primitives, 'writeClipboard') ?? (text => globalObject.navigator?.clipboard?.writeText(text))

    const STYLE_ID = 'dsh-desktop-conversation-replay-style'
    const STYLE = `
[data-dsh-conversation-replay-row] {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}
[data-dsh-conversation-replay-stack] {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  min-width: 0;
  max-width: min(525px, 82%);
}
[data-dsh-conversation-replay-bubble] {
  max-width: 100%;
  padding: 10px 16px;
  border-radius: 22px;
  background: var(--dsw-specific-bubble);
  color: var(--dsw-alias-label-primary);
  font-size: 16px;
  line-height: 24px;
}
[data-dsh-conversation-replay-textclip] {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  max-width: 100%;
}
[data-dsh-conversation-replay-textclip-toggle] {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: min(320px, 82vw);
  height: 26px;
  padding: 0 7px;
  border: 1px solid var(--dsw-alias-stroke-primary);
  border-radius: 6px;
  background: color-mix(in srgb, currentColor 7%, transparent);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font: 500 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
}
[data-dsh-conversation-replay-textclip-icon] { flex: none; font-size: 12px; line-height: 1; }
[data-dsh-conversation-replay-textclip-label] {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-dsh-conversation-replay-textclip-type] {
  flex: none;
  opacity: .58;
  font: 10px/1 ui-monospace, SFMono-Regular, Consolas, monospace;
}
[data-dsh-conversation-replay-textclip-expanded] {
  max-height: 360px;
  overflow: auto;
  overflow-wrap: anywhere;
}
[data-dsh-conversation-replay-actions] {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 28px;
}
[data-dsh-conversation-replay-time] {
  padding-right: 12px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 14px;
  line-height: 24px;
  white-space: nowrap;
}
@media (hover: hover) {
  [data-dsh-conversation-replay-time] { opacity: 0; transition: opacity 80ms ease; }
  [data-dsh-conversation-replay-row]:hover [data-dsh-conversation-replay-time],
  [data-dsh-conversation-replay-row]:focus-within [data-dsh-conversation-replay-time] { opacity: 1; }
}
[data-dsh-conversation-replay-action] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 6px;
  border: none;
  border-radius: 28px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
[data-dsh-conversation-replay-action]:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-conversation-replay-action]:disabled { cursor: default; opacity: .4; }
[data-dsh-conversation-replay-editor] {
  width: min(525px, 82vw);
  min-height: 112px;
  padding: 12px 14px;
  resize: vertical;
  border: 1px solid var(--dsw-alias-stroke-primary);
  border-radius: 16px;
  outline: none;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  line-height: 24px;
}
[data-dsh-conversation-replay-editor]:focus {
  border-color: var(--dsw-alias-button-info-fill);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-button-info-fill) 18%, transparent);
}
[data-dsh-conversation-replay-editor-actions] {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
[data-dsh-conversation-replay-editor-button] {
  min-height: 32px;
  padding: 0 13px;
  border: 1px solid var(--dsw-alias-stroke-primary);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
[data-dsh-conversation-replay-editor-button='confirm'] {
  border-color: transparent;
  background: var(--dsw-alias-button-info-fill);
  color: var(--dsw-alias-button-info-label);
}
[data-dsh-conversation-replay-editor-button]:disabled { cursor: default; opacity: .45; }
[data-dsh-conversation-replay-error] {
  max-width: min(525px, 82%);
  color: var(--dsw-alias-state-error-primary);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
}
`

    const TEXT_CLIP_THRESHOLD = 500

    function isLongTextClip(text) {
      return Array.from(text).length > TEXT_CLIP_THRESHOLD
    }

    function textClipLabel(text) {
      const clean = text.replace(/\s+/g, ' ').trim()
      if (clean.length === 0) return '粘贴的文本'
      return clean.length <= 15 ? clean : `${clean.slice(0, 15).trim()}…`
    }

    function contentParts(content) {
      const texts = []
      const images = []
      const rest = []
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
        else if (block?.type === 'image' && block.attachment !== undefined) images.push({ attachment: block.attachment })
        else rest.push(block)
      }
      return { text: texts.join(''), images, rest }
    }

    function bytesToBase64(bytes) {
      let binary = ''
      const step = 0x8000
      for (let offset = 0; offset < bytes.length; offset += step) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + step))
      }
      return btoa(binary)
    }

    async function promptContent(session, content, replacementText) {
      const result = []
      let replaced = replacementText === undefined
      let sawText = false
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          sawText = true
          if (replacementText === undefined) result.push({ type: 'text', text: block.text })
          else if (!replaced) {
            if (replacementText !== '') result.push({ type: 'text', text: replacementText })
            replaced = true
          }
          continue
        }
        if (block?.type === 'image' && block.attachment?.attachmentId !== undefined) {
          const read = await session.readAttachment(block.attachment.attachmentId)
          if (!read?.ok) throw new Error(read?.error?.message ?? '读取原消息图片失败')
          const attachment = read.value.attachment
          result.push({
            type: 'image',
            mediaType: attachment.mediaType,
            data: bytesToBase64(read.value.data),
            ...(attachment.name === undefined ? {} : { name: attachment.name }),
          })
          continue
        }
        throw new Error('当前消息包含暂不支持重新发送的内容')
      }
      if (replacementText !== undefined && !sawText && replacementText !== '') {
        result.unshift({ type: 'text', text: replacementText })
      }
      return result
    }

    async function replayMessage(ctx, { sessionId, node, content, replacementText }) {
      const source = ctx.sessions.binding(sessionId)?.session
      if (source === undefined) throw new Error('当前会话尚未就绪')
      if (typeof source.desktopReplay !== 'function') throw new Error('当前 Runtime 与壳侧原会话重试适配尚未就绪')
      if (!Number.isSafeInteger(node?.data?.seq)) throw new Error('消息序号无效')
      const prompt = await promptContent(source, content, replacementText)
      if (prompt.length === 0) throw new Error('消息内容不能为空')
      const sent = await source.desktopReplay(node.data.seq, prompt)
      if (!sent?.ok) {
        const reason = sent?.error?.details?.reason
        throw new Error(typeof reason === 'string' ? reason : sent?.error?.message ?? '重新发送失败')
      }
      return sessionId
    }

    function projectUserText(text) {
      const expression = /(^|\s)([/@][\w-]+)(?=\s|$)/g
      const parts = []
      let cursor = 0
      let match
      while ((match = expression.exec(text)) !== null) {
        const tokenStart = match.index + (match[1]?.length ?? 0)
        const label = match[2] ?? ''
        if (tokenStart > cursor) parts.push(React.createElement(MessageText, { key: cursor, text: text.slice(cursor, tokenStart) }))
        parts.push(React.createElement('span', {
          key: tokenStart,
          'data-ref-chip': label.startsWith('@') ? 'subagent' : 'skill',
          style: { fontWeight: 500 },
        }, label))
        cursor = tokenStart + label.length
      }
      if (parts.length === 0) return React.createElement(MessageText, { text })
      if (cursor < text.length) parts.push(React.createElement(MessageText, { key: cursor, text: text.slice(cursor) }))
      return React.createElement(React.Fragment, null, ...parts)
    }

    function imageLabels() {
      return {
        image: '图片',
        open: '查看原图',
        openNamed: label => `查看 ${label}`,
        loading: '加载中',
        loadFailed: '加载失败，点击重试',
        lightbox: { dialog: '原图预览', close: '关闭原图' },
      }
    }

    function formatTime(value) {
      try {
        return new Intl.DateTimeFormat(undefined, {
          month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(new Date(value))
      } catch {
        return ''
      }
    }

    function actionButton(label, icon, onClick, disabled) {
      return React.createElement(Tooltip, { label, side: 'bottom' }, React.createElement('button', {
        type: 'button',
        'data-dsh-conversation-replay-action': true,
        'aria-label': label,
        disabled,
        onClick,
      }, React.createElement(icon)))
    }

    function LongTextClip({ text }) {
      const [expanded, setExpanded] = React.useState(false)
      const label = textClipLabel(text)
      return React.createElement('div', {
        'data-dsh-conversation-replay-textclip': expanded ? 'expanded' : 'collapsed',
      },
      React.createElement('button', {
        type: 'button',
        'data-dsh-conversation-replay-textclip-toggle': true,
        'aria-expanded': expanded,
        'aria-label': `${expanded ? '收起' : '展开'}长文本：${label}`,
        title: expanded ? '点击收起长文本' : '点击展开长文本',
        onClick: () => { setExpanded(value => !value) },
      },
      React.createElement('span', { 'data-dsh-conversation-replay-textclip-icon': true, 'aria-hidden': true }, '📋'),
      React.createElement('span', { 'data-dsh-conversation-replay-textclip-label': true }, label),
      React.createElement('span', { 'data-dsh-conversation-replay-textclip-type': true }, '.textclip')),
      expanded && React.createElement('div', {
        'data-dsh-conversation-replay-bubble': true,
        'data-dsh-conversation-replay-textclip-expanded': true,
      }, projectUserText(text)))
    }

    function createUserMessageNodeView(ctx) {
      return React.memo(function UserMessageNodeView({ node, loadImage, renderMessageImages, sessionId, useSession }) {
        const data = node.data
        const removed = useSession(snapshot => snapshot.removed)
        const running = useSession(snapshot => snapshot.running)
        const { text, images, rest } = React.useMemo(() => contentParts(data.content), [data.content])
        const longTextClip = React.useMemo(() => isLongTextClip(text), [text])
        const [editing, setEditing] = React.useState(false)
        const [draft, setDraft] = React.useState(text)
        const [busy, setBusy] = React.useState(false)
        const [copied, setCopied] = React.useState(false)
        const [error, setError] = React.useState('')
        const replayable = rest.length === 0
        const disabled = busy || running || removed || !replayable

        React.useEffect(() => { if (!editing) setDraft(text) }, [editing, text])
        React.useEffect(() => {
          if (!copied) return undefined
          const timer = window.setTimeout(() => { setCopied(false) }, 1_000)
          return () => { window.clearTimeout(timer) }
        }, [copied])

        const run = React.useCallback(async (replacementText) => {
          if (busy) return
          setBusy(true)
          setError('')
          try {
            await replayMessage(ctx, { sessionId, node, content: data.content, replacementText })
            setEditing(false)
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason))
          } finally {
            setBusy(false)
          }
        }, [busy, ctx, data.content, data.seq, node, sessionId])

        const copy = React.useCallback(() => {
          if (copied) return
          void Promise.resolve(writeClipboard(text)).then(() => { setCopied(true) }).catch(() => {})
        }, [copied, text])

        const cancelEdit = React.useCallback(() => {
          if (busy) return
          setDraft(text)
          setEditing(false)
          setError('')
        }, [busy, text])

        const submitEdit = React.useCallback(() => {
          if (draft.trim() === '' && images.length === 0) return
          void run(draft)
        }, [draft, images.length, run])

        const imageContent = images.length === 0
          ? null
          : typeof renderMessageImages === 'function'
            ? renderMessageImages({ images, align: 'end' })
            : typeof loadImage === 'function' && ImageGallery !== undefined
              ? React.createElement(ImageGallery, { images, load: loadImage, align: 'end', labels: imageLabels() })
              : null

        const bubble = editing
          ? React.createElement(React.Fragment, null,
            React.createElement('textarea', {
              autoFocus: true,
              value: draft,
              disabled: busy,
              'data-dsh-conversation-replay-editor': true,
              onChange: event => { setDraft(event.currentTarget.value) },
              onKeyDown: event => {
                if (event.key === 'Escape') cancelEdit()
                else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault()
                  submitEdit()
                }
              },
            }),
            React.createElement('div', { 'data-dsh-conversation-replay-editor-actions': true },
              React.createElement('button', {
                type: 'button',
                disabled: busy,
                'data-dsh-conversation-replay-editor-button': 'cancel',
                onClick: cancelEdit,
              }, '取消'),
              React.createElement('button', {
                type: 'button',
                disabled: disabled || (draft.trim() === '' && images.length === 0),
                'data-dsh-conversation-replay-editor-button': 'confirm',
                onClick: submitEdit,
              }, busy ? '正在重新发送…' : '确认并重新发送'),
            ),
          )
          : React.createElement(React.Fragment, null,
            imageContent,
            text !== '' && longTextClip
              ? React.createElement(LongTextClip, { text })
              : (text !== '' || rest.length > 0) && React.createElement('div', { 'data-dsh-conversation-replay-bubble': true },
                text !== '' && projectUserText(text),
                ...rest.map((block, index) => React.createElement(JsonBlock, {
                  key: index,
                  label: '附加内容',
                  payload: block,
                  truncatedLabel: total => `已截断，共 ${total} 项`,
                })),
              ),
            text !== '' && longTextClip && rest.length > 0 && React.createElement('div', { 'data-dsh-conversation-replay-bubble': true },
              ...rest.map((block, index) => React.createElement(JsonBlock, {
                key: index,
                label: '附加内容',
                payload: block,
                truncatedLabel: total => `已截断，共 ${total} 项`,
              })),
            ),
          )

        return React.createElement('div', {
          'data-dsh-conversation-replay-row': true,
          'data-time-hover-root': true,
        },
        React.createElement('div', { 'data-dsh-conversation-replay-stack': true }, bubble),
        !editing && React.createElement('div', { 'data-dsh-conversation-replay-actions': true },
          React.createElement('span', { 'data-dsh-conversation-replay-time': true }, formatTime(data.time)),
          actionButton(copied ? '已复制' : '复制', copied ? IconCheckOutline16 : IconCopyOutline16, copy, false),
          actionButton(replayable ? '重试此消息' : '该消息包含不支持重新发送的内容', IconRefreshOutline16, () => { void run(undefined) }, disabled),
          actionButton(replayable ? '编辑此消息' : '该消息包含不支持编辑的内容', IconEditOutline16, () => {
            setDraft(text)
            setEditing(true)
            setError('')
          }, disabled),
        ),
        editing && busy && React.createElement('div', { 'data-dsh-conversation-replay-error': true }, '正在清理后续对话并重新发起请求…'),
        error !== '' && React.createElement('div', { 'data-dsh-conversation-replay-error': true }, error))
      })
    }

    function apply(ctx) {
      let style = document.getElementById(STYLE_ID)
      let ownsStyle = false
      if (style === null) {
        style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = STYLE
        document.head.appendChild(style)
        ownsStyle = true
      }
      if (ownsStyle) ctx.effect(() => () => { style.remove() }, 'desktop-shell-conversation-replay: styles')
      const UserMessageNodeView = createUserMessageNodeView(ctx)
      ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node',
        key: 'user',
        priority: -100,
        registrant: '@deepseek-ai/dsh-desktop-shell-conversation-replay',
      }, UserMessageNodeView))
    }

    return {
      apply,
      contentParts,
      isLongTextClip,
      textClipLabel,
      promptContent,
      replayMessage,
    }
  }

  const installedContexts = new WeakSet()
  const scheduledContexts = new WeakSet()
  const wrappedFactories = new WeakMap()
  const loaderProxies = new WeakMap()
  const bootstrapModuleId = '@deepseek-ai/dsh-client-modules'
  const featureDependencyIds = [
    'react',
    '@deepseek-ai/dsh-client-ui-primitives',
  ]
  const optionalFeatureDependencyIds = ['@deepseek-ai/dsh-client-ui-attachment']
  const featureServiceIds = ['slots', 'sessions']
  let legacySuppressions = 0
  let targetRegistrations = 0
  let targetFactories = 0
  let targetApplies = 0
  let featureApplications = 0
  let featureFailures = 0
  let boundaryFailures = 0
  let lastSlotEntries = []
  let capturedContext
  let capturedModules = globalObject.__DSH_MODULES__
  let feature
  let featureRequire
  let recoveryPromise
  let loaderRepairAttempts = 0

  function reportBoundaryFailure(message, error) {
    boundaryFailures += 1
    console.error(message, error)
  }

  function exposeModules(modules) {
    if (modules === null || (typeof modules !== 'object' && typeof modules !== 'function')) return
    capturedModules = modules
  }

  function captureContext(ctx) {
    if (ctx === null || (typeof ctx !== 'object' && typeof ctx !== 'function')) return
    capturedContext = ctx
    applyFeature(ctx)
  }

  function applyFeature(ctx, require) {
    if (ctx === null || (typeof ctx !== 'object' && typeof ctx !== 'function') || installedContexts.has(ctx) || scheduledContexts.has(ctx)) return
    if (typeof require === 'function') featureRequire = require
    if (feature === undefined && featureRequire !== undefined) {
      try { feature = createConversationReplayFeature(featureRequire) }
      catch (error) {
        featureFailures += 1
        console.error('桌面壳对话编辑与重试功能注入失败', error)
        return
      }
    }
    if (feature !== undefined) {
      const install = featureContext => {
        try {
          feature.apply(featureContext)
          featureApplications += 1
          installedContexts.add(ctx)
        } catch (error) {
          featureFailures += 1
          console.error('桌面壳对话编辑与重试功能注入失败', error)
        }
      }
      scheduledContexts.add(ctx)
      try {
        if (typeof ctx.inject === 'function') ctx.inject(featureServiceIds, install)
        else install(ctx)
      } catch (error) {
        featureFailures += 1
        console.error('桌面壳对话编辑与重试功能注入失败', error)
      }
      return
    }
    const modules = capturedModules
    if (recoveryPromise !== undefined || typeof modules?.import !== 'function') return
    recoveryPromise = Promise.resolve().then(async () => {
      const required = await Promise.all(featureDependencyIds.map(id => modules.import(id)))
      const optional = await Promise.all(optionalFeatureDependencyIds.map(id => Promise.resolve().then(() => modules.import(id)).catch(() => undefined)))
      return [...required, ...optional]
    }).then(values => {
      const dependencyIds = [...featureDependencyIds, ...optionalFeatureDependencyIds]
      const dependencies = new Map(dependencyIds.map((id, index) => [id, values[index]]))
      const requireFromModules = id => {
        if (!dependencies.has(id) || dependencies.get(id) === undefined) throw new Error('对话编辑与重试注入依赖未找到：' + id)
        return dependencies.get(id)
      }
      applyFeature(ctx, requireFromModules)
    }).catch(error => {
      featureFailures += 1
      console.error('桌面壳对话编辑与重试功能注入失败', error)
    }).finally(() => { recoveryPromise = undefined })
  }

  function wrapFactory(factory, moduleId) {
    const existing = wrappedFactories.get(factory)
    if (existing !== undefined) return existing
    const wrapped = function (require) {
      if (moduleId === targetModuleId) targetFactories += 1
      const exports = factory(require)
      try {
        if (exports === null || (typeof exports !== 'object' && typeof exports !== 'function')) return exports
        const originalApply = exports.apply
        if (typeof originalApply !== 'function') return exports
        const wrappedApply = function (...args) {
          const result = originalApply.apply(this, args)
          try {
            const ctx = args[0]
            if (moduleId === targetModuleId) {
              targetApplies += 1
              applyFeature(capturedContext ?? ctx, require)
            } else if (moduleId === bootstrapModuleId) captureContext(ctx)
            if (ctx !== null && (typeof ctx === 'object' || typeof ctx === 'function')) {
              try {
                const entries = typeof ctx.slots?.entriesOfSlot === 'function'
                  ? ctx.slots.entriesOfSlot('conversation.chat.node')
                  : typeof ctx.slots?.entries === 'function'
                    ? ctx.slots.entries('conversation.chat.node')
                    : []
                lastSlotEntries = entries.map(entry => ({
                  key: entry?.options?.key,
                  priority: entry?.options?.priority,
                  registrant: entry?.options?.registrant,
                  component: entry?.component?.name,
                }))
              } catch {}
            }
          } catch (error) {
            reportBoundaryFailure('桌面壳客户端模块 apply 增强失败', error)
          }
          return result
        }
        Object.defineProperty(exports, 'apply', {
          ...Object.getOwnPropertyDescriptor(exports, 'apply'),
          value: wrappedApply,
        })
        if (moduleId === bootstrapModuleId) {
          const originalCreate = exports.createClientModuleSystem
          if (typeof originalCreate === 'function') {
            Object.defineProperty(exports, 'createClientModuleSystem', {
              ...Object.getOwnPropertyDescriptor(exports, 'createClientModuleSystem'),
              value: function (...args) {
                const modules = originalCreate.apply(this, args)
                try {
                  exposeModules(modules)
                  applyFeature(capturedContext)
                } catch (error) {
                  reportBoundaryFailure('桌面壳客户端模块系统增强失败', error)
                }
                return modules
              },
            })
          }
        }
      } catch (error) {
        reportBoundaryFailure('桌面壳客户端模块工厂增强失败', error)
      }
      return exports
    }
    wrappedFactories.set(factory, wrapped)
    return wrapped
  }

  function registerModuleFactoryTransform(moduleId, transform) {
    if (typeof moduleId !== 'string' || moduleId.length === 0 || typeof transform !== 'function') return false
    const previous = moduleFactoryTransforms.get(moduleId)
    moduleFactoryTransforms.set(moduleId, factory => {
      let current = factory
      for (const apply of [previous, transform]) {
        if (typeof apply !== 'function') continue
        try {
          const result = apply(current)
          if (typeof result === 'function') current = result
        } catch (error) {
          reportBoundaryFailure('桌面壳客户端模块转换失败，保留已有增强', error)
        }
      }
      return current
    })
    return true
  }

  function transformFactory(handoff) {
    try {
      const transform = moduleFactoryTransforms.get(handoff?.id)
      if (typeof transform !== 'function' || typeof handoff?.factory !== 'function') return handoff
      const originalFactory = handoff.factory
      const transformedFactory = transform(originalFactory)
      if (typeof transformedFactory !== 'function' || transformedFactory === originalFactory) return handoff
      const factory = function (...args) {
        try { return Reflect.apply(transformedFactory, this, args) }
        catch (error) {
          reportBoundaryFailure('桌面壳客户端模块转换执行失败', error)
          return Reflect.apply(originalFactory, this, args)
        }
      }
      return { ...handoff, factory }
    } catch (error) {
      console.error('桌面壳客户端模块转换失败', error)
      return handoff
    }
  }

  function prepareHandoff(handoff) {
    const originalHandoff = handoff
    try {
      handoff = transformFactory(handoff)
      if (handoff?.id === targetModuleId && typeof handoff.factory === 'function') {
        const factory = wrapFactory(handoff.factory, handoff.id)
        if (factory !== handoff.factory) targetRegistrations += 1
        return { ...handoff, factory }
      }
      if (handoff?.id === bootstrapModuleId && typeof handoff.factory === 'function') {
        return { ...handoff, factory: wrapFactory(handoff.factory, handoff.id) }
      }
      if (handoff?.id === legacyModuleId && typeof handoff.factory === 'function') {
        legacySuppressions += 1
        return { ...handoff, factory: () => ({ inject: [], apply() {} }) }
      }
      return handoff
    } catch (error) {
      reportBoundaryFailure('桌面壳 ModuleLoader 模块预处理失败', error)
      return originalHandoff
    }
  }

  function wrapLoader(loader) {
    if (loader === undefined || loader === null || (typeof loader !== 'object' && typeof loader !== 'function')) return loader
    const existing = loaderProxies.get(loader)
    if (existing !== undefined) return existing
    const wrappers = new WeakMap()
    const createWrappers = new WeakMap()
    const delegates = new WeakMap()
    const proxy = new Proxy(loader, {
      get(target, property, receiver) {
        if (property === 'create') {
          const delegate = Reflect.get(target, property, target)
          if (typeof delegate !== 'function') return delegate
          const existingWrapper = createWrappers.get(delegate)
          if (existingWrapper !== undefined) return existingWrapper
          const wrapper = function (...args) {
            try {
              const queue = Reflect.get(target, 'pendingQueue', target)
              if (Array.isArray(queue)) {
                for (let index = 0; index < queue.length; index += 1) queue[index] = prepareHandoff(queue[index])
              }
            } catch (error) {
              reportBoundaryFailure('桌面壳 ModuleLoader 队列预处理失败', error)
            }
            return Reflect.apply(delegate, target, args)
          }
          createWrappers.set(delegate, wrapper)
          return wrapper
        }
        if (property !== 'load') return Reflect.get(target, property, receiver)
        const delegate = Reflect.get(target, property, target)
        if (typeof delegate !== 'function') return delegate
        const existingWrapper = wrappers.get(delegate)
        if (existingWrapper !== undefined) return existingWrapper
        const wrapper = function (handoff) {
          return Reflect.apply(delegate, target, [prepareHandoff(handoff)])
        }
        wrappers.set(delegate, wrapper)
        delegates.set(wrapper, delegate)
        return wrapper
      },
      set(target, property, value) {
        const delegate = property === 'load' && typeof value === 'function' ? delegates.get(value) : undefined
        return Reflect.set(target, property, delegate ?? value, target)
      },
      defineProperty(target, property, descriptor) {
        if (property !== 'load' || typeof descriptor.value !== 'function') return Reflect.defineProperty(target, property, descriptor)
        const delegate = delegates.get(descriptor.value)
        return Reflect.defineProperty(target, property, { ...descriptor, value: delegate ?? descriptor.value })
      },
    })
    loaderProxies.set(loader, proxy)
    loaderProxies.set(proxy, proxy)
    return proxy
  }

  let currentLoader
  try { currentLoader = wrapLoader(globalObject.__ModuleLoader__) }
  catch (error) {
    currentLoader = globalObject.__ModuleLoader__
    reportBoundaryFailure('桌面壳 ModuleLoader 初始接管失败', error)
  }
  const loaderGetter = () => currentLoader
  const loaderSetter = value => {
    try { currentLoader = wrapLoader(value) }
    catch (error) {
      currentLoader = value
      reportBoundaryFailure('桌面壳 ModuleLoader 赋值接管失败', error)
    }
  }
  const ensureLoaderAccessor = () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalObject, '__ModuleLoader__')
    if (descriptor?.get === loaderGetter && descriptor?.set === loaderSetter) return
    const value = descriptor === undefined
      ? undefined
      : typeof descriptor.get === 'function'
        ? descriptor.get.call(globalObject)
        : descriptor.value
    try { currentLoader = wrapLoader(value) }
    catch (error) {
      currentLoader = value
      reportBoundaryFailure('桌面壳 ModuleLoader 接管恢复失败', error)
    }
    Object.defineProperty(globalObject, '__ModuleLoader__', {
      configurable: true,
      enumerable: false,
      get: loaderGetter,
      set: loaderSetter,
    })
  }
  const repairLoaderAccessor = () => {
    try {
      ensureLoaderAccessor()
      applyFeature(capturedContext)
    } catch (error) {
      console.error('桌面壳 ModuleLoader 接管恢复失败', error)
    }
  }
  Object.defineProperty(globalObject, '__ModuleLoader__', {
    configurable: true,
    enumerable: false,
    get: loaderGetter,
    set: loaderSetter,
  })
  if (typeof globalObject.addEventListener === 'function') {
    globalObject.addEventListener('DOMContentLoaded', repairLoaderAccessor, { once: true })
    globalObject.addEventListener('load', repairLoaderAccessor, { once: true })
    globalObject.addEventListener('pageshow', repairLoaderAccessor)
  }
  if (typeof globalObject.queueMicrotask === 'function') globalObject.queueMicrotask(repairLoaderAccessor)
  const pollLoaderAccessor = () => {
    repairLoaderAccessor()
    loaderRepairAttempts += 1
    if (loaderRepairAttempts < 120 && targetApplies === 0 && featureApplications === 0 && typeof globalObject.setTimeout === 'function') {
      globalObject.setTimeout(pollLoaderAccessor, 250)
    }
  }
  const protocol = typeof globalObject.location?.protocol === 'string' ? globalObject.location.protocol : ''
  if ((protocol === 'http:' || protocol === 'https:') && typeof globalObject.setTimeout === 'function') {
    globalObject.setTimeout(pollLoaderAccessor, 0)
  }
  Object.defineProperty(globalObject, hookKey, {
    configurable: true,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      version: 1,
      targetModuleId,
      legacyModuleId,
      createFeature: createConversationReplayFeature,
      registerModuleFactoryTransform,
      ensureLoaderAccessor,
      get legacySuppressions() { return legacySuppressions },
      get diagnostics() {
        return {
          targetRegistrations,
          targetFactories,
          targetApplies,
          featureApplications,
          featureFailures,
          boundaryFailures,
          lastSlotEntries,
        }
      },
    }),
  })
  return 'installed'
}
