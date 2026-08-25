export function createFileContextInjectorScript(): string {
  return String.raw`(() => {
  'use strict';
  const key = '__dshDesktopFileContext';
  const previous = window[key];
  if (previous && typeof previous.dispose === 'function') previous.dispose();
  const MAX_BYTES = 8 * 1024 * 1024;
  const LARGE_FILE_BYTES = 2 * 1024 * 1024;
  const MAX_INLINE_CHARS = 500;
  const MAX_FILES = 32;
  const BINARY_EXTENSIONS = /\.(?:7z|avi|bin|bmp|class|db|dll|dmg|doc|docx|eot|exe|gif|ico|iso|jar|jpeg|jpg|lib|m4a|mov|mp3|mp4|msi|otf|pdf|png|ppt|pptx|rar|so|sqlite|sys|tar|tif|tiff|ttf|wav|webm|webp|woff|woff2|xls|xlsx|zip)$/i;
  const CLIP_ATTR = 'data-dsh-clip';
  const TRAY_ATTR = 'data-dsh-clip-tray';
  const disposers = [];
  const clips = new Map();
  let clipSequence = 0;
  let busy = false;
  let replayingSubmit = false;
  const CHAT_EDITOR_SELECTOR = '[data-composer-card="true"] [data-input-scroll="true"] textarea,[data-composer-card="true"] [data-input-scroll="true"] [contenteditable="true"]';
  const isChatEditor = node => node instanceof HTMLElement && node.matches('textarea,[contenteditable="true"]') && Boolean(node.closest('[data-composer-card="true"]')) && Boolean(node.closest('[data-input-scroll="true"]'));
  const editorFromTarget = target => target instanceof Element ? target.closest('textarea,[contenteditable="true"]') : null;
  const findEditor = () => [...document.querySelectorAll(CHAT_EDITOR_SELECTOR)].find(node => isChatEditor(node) && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0) || null;
  const readValue = node => node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement ? node.value : node.innerText;
  const writeValue = (node, value) => {
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value');
      if (descriptor && descriptor.set) descriptor.set.call(node, value); else node.value = value;
    } else node.innerText = value;
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
  };
  const truncateLabel = (label, max = 24) => {
    const clean = String(label || '');
    if (clean.length <= max) return clean;
    const dot = clean.lastIndexOf('.');
    const base = dot > 0 ? clean.slice(0, dot) : clean;
    const ext = dot > 0 ? clean.slice(dot) : '';
    const keep = max - ext.length - 1;
    if (keep <= 0) return '…' + ext;
    return base.slice(0, keep) + '…' + ext;
  };
  const fileLabel = name => {
    const short = truncateLabel(name);
    const dot = short.lastIndexOf('.');
    return dot > 0 ? short : short + '.textclip';
  };
  const textClipName = text => {
    const prefix = text.replace(/\s+/g, ' ').trim().slice(0, 32).replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '_').slice(0, 32);
    return (prefix || 'pasted_text') + '.textclip';
  };
  const textClipLabel = text => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length === 0) return '粘贴的文本';
    return clean.length <= 15 ? clean : clean.slice(0, 15).trim() + '…';
  };
  const attachmentHost = editor => {
    const composer = editor.closest('[data-composer-card="true"]');
    return composer && composer.querySelector('[data-slot="conversation.input.attachments"]');
  };
  const ensureTray = editor => {
    const host = attachmentHost(editor);
    let tray = (host || document).querySelector('[' + TRAY_ATTR + ']');
    if (tray) return tray;
    tray = document.createElement('div');
    tray.setAttribute(TRAY_ATTR, 'true');
    tray.setAttribute('role', 'group');
    tray.setAttribute('aria-label', '待发送文本附件');
    tray.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:8px 12px 2px;position:relative;z-index:2;';
    if (host) host.appendChild(tray);
    else {
      const anchor = editor.closest('[data-input-scroll="true"]') || editor;
      if (!anchor.parentElement) throw new Error('未找到 DSH 附件挂载区域');
      anchor.parentElement.insertBefore(tray, anchor);
    }
    return tray;
  };
  const cleanupTray = tray => { if (tray && tray.childElementCount === 0) tray.remove(); };
  const removeClip = id => {
    const entry = clips.get(id);
    if (!entry) return;
    const tray = entry.element && entry.element.parentElement;
    if (entry.element) entry.element.remove();
    clips.delete(id);
    cleanupTray(tray);
  };
  const formatBytes = bytes => bytes >= 1024 * 1024
    ? (bytes / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' MB'
    : Math.ceil(bytes / 1024).toLocaleString() + ' KB';
  const largeFileContext = (name, absolutePath, bytes) => '\n\n--- 用户粘贴大文本文件：' + name + ' ---\n'
    + '文件绝对路径：' + absolutePath + '\n'
    + '文件大小：' + bytes.toLocaleString() + ' 字节（' + formatBytes(bytes) + '）\n'
    + '请使用文件读取工具按区段分批读取此文件。先获取文件行数或按行号/偏移量逐段读取，不要一次性加载完整文件，以避免耗尽上下文。\n'
    + '--- 用户粘贴大文本文件结束 ---';
  const entryContent = entry => entry.absolutePath
    ? largeFileContext(entry.name, entry.absolutePath, entry.bytes)
    : entry.isFile ? fileContext(entry.name, entry.text) : entry.text;
  const appendEntry = (value, entry) => {
    const content = entryContent(entry);
    if (entry.isFile || value.length === 0) return value + content;
    return value + (value.endsWith('\n') ? '\n' : '\n\n') + content;
  };
  const expandClipElement = element => {
    const id = element.getAttribute(CLIP_ATTR);
    const entry = clips.get(id);
    const editor = findEditor();
    if (!entry || !editor) return;
    writeValue(editor, appendEntry(readValue(editor), entry));
    removeClip(id);
    editor.focus();
  };
  const showPreview = (preview, visible) => { preview.hidden = !visible; };
  const clipHtml = (id, name, text, isFile, largeFile) => {
    const length = Array.from(text).length;
    const large = largeFile !== undefined;
    const wrapper = document.createElement('span');
    wrapper.setAttribute(CLIP_ATTR, id);
    wrapper.setAttribute('data-dsh-name', name);
    wrapper.setAttribute('data-dsh-kind', large ? 'large-file' : isFile ? 'file' : 'textclip');
    wrapper.style.cssText = 'display:inline-flex;position:relative;max-width:100%;';
    const badge = document.createElement('span');
    badge.setAttribute('role', 'button');
    badge.setAttribute('tabindex', '0');
    badge.setAttribute('aria-label', (large ? '大文本文件路径 ' : isFile ? '文本文件 ' : '粘贴的文本 ') + name + '，点击展开');
    badge.title = large ? '点击展开文件路径和分段读取指令' : '点击展开为原始文本';
    badge.style.cssText = 'display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:320px;height:26px;box-sizing:border-box;padding:0 7px;border:1px solid rgba(127,127,127,.34);border-radius:6px;background:color-mix(in srgb,currentColor 7%,transparent);color:inherit;font:500 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;user-select:none;';
    const icon = document.createElement('span');
    icon.textContent = '📋';
    icon.setAttribute('aria-hidden', 'true');
    icon.style.cssText = 'font-size:12px;line-height:1;';
    const label = document.createElement('span');
    label.textContent = isFile ? fileLabel(name) : textClipLabel(text);
    label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    const type = document.createElement('span');
    type.textContent = large ? formatBytes(largeFile.bytes) + ' · 路径' : isFile ? length + ' 字符' : '.textclip';
    type.style.cssText = 'flex:none;opacity:.58;font:10px/1 ui-monospace,SFMono-Regular,Consolas,monospace;';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', '移除附件 ' + name);
    remove.title = '移除附件';
    remove.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;padding:0;border:0;border-radius:3px;background:transparent;color:inherit;font:15px/1 system-ui;cursor:pointer;opacity:.62;';
    badge.append(icon, label, type, remove);
    const preview = document.createElement('span');
    preview.hidden = true;
    preview.setAttribute('role', 'tooltip');
    preview.style.cssText = 'position:absolute;left:0;bottom:calc(100% + 8px);z-index:1000;width:min(360px,calc(100vw - 40px));box-sizing:border-box;padding:12px;border:1px solid rgba(127,127,127,.3);border-radius:8px;background:Canvas;color:CanvasText;box-shadow:0 10px 28px rgba(0,0,0,.22);font:12px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;';
    const previewTitle = document.createElement('span');
    previewTitle.textContent = large
      ? fileLabel(name) + '（' + formatBytes(largeFile.bytes) + '，仅发送路径）'
      : (isFile ? fileLabel(name) : '粘贴的文本') + ' (' + length.toLocaleString() + ' characters)';
    previewTitle.style.cssText = 'display:block;padding-right:26px;font-weight:600;';
    const previewText = document.createElement('span');
    previewText.textContent = large
      ? '绝对路径：' + largeFile.absolutePath + '\n提交时不会读取或发送文件全文，模型将按区段读取此文件。'
      : text.length > 50_000 ? text.slice(0, 50_000) + '…' : text;
    previewText.style.cssText = 'display:block;max-height:160px;margin-top:8px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;opacity:.72;font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = '⧉';
    copy.setAttribute('aria-label', '复制附件内容');
    copy.title = '复制附件内容';
    copy.style.cssText = 'position:absolute;top:8px;right:8px;width:22px;height:22px;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer;';
    copy.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void navigator.clipboard.writeText(large ? largeFile.absolutePath : text).catch(() => {}); });
    preview.append(previewTitle, previewText, copy);
    const expand = event => { event.preventDefault(); event.stopPropagation(); expandClipElement(wrapper); };
    let previewHideTimer;
    const cancelPreviewHide = () => {
      if (previewHideTimer === undefined) return;
      clearTimeout(previewHideTimer);
      previewHideTimer = undefined;
    };
    const showPreviewNow = () => { cancelPreviewHide(); showPreview(preview, true); };
    const schedulePreviewHide = () => {
      cancelPreviewHide();
      previewHideTimer = setTimeout(() => {
        previewHideTimer = undefined;
        showPreview(preview, false);
      }, 220);
    };
    badge.addEventListener('click', expand);
    badge.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') expand(event); });
    remove.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); removeClip(id); });
    wrapper.addEventListener('mouseenter', showPreviewNow);
    wrapper.addEventListener('mouseleave', schedulePreviewHide);
    preview.addEventListener('mouseenter', showPreviewNow);
    preview.addEventListener('mouseleave', schedulePreviewHide);
    badge.addEventListener('focus', showPreviewNow);
    badge.addEventListener('blur', event => { if (!(event.relatedTarget instanceof Node) || !wrapper.contains(event.relatedTarget)) schedulePreviewHide(); });
    wrapper.append(badge, preview);
    return wrapper;
  };
  const fileContext = (name, text) => '\n\n--- 用户粘贴文件：' + name + ' ---\n' + text + '\n--- 用户粘贴文件结束 ---';
  const insertClip = (editor, name, text, isFile, largeFile) => {
    const marker = largeFile ? '--- 用户粘贴大文本文件：' + name + ' ---' : isFile ? '--- 用户粘贴文件：' + name + ' ---' : '';
    if (marker && readValue(editor).includes(marker)) return;
    if ([...clips.values()].some(entry => entry.name === name)) return;
    const id = 'clip-' + (++clipSequence);
    const element = clipHtml(id, name, text, isFile, largeFile);
    clips.set(id, { name, text, isFile, element, ...(largeFile || {}) });
    ensureTray(editor).appendChild(element);
  };
  const appendText = (editor, text) => {
    if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error('粘贴文本超过 8 MB 限制');
    const length = Array.from(text).length;
    if (length <= MAX_INLINE_CHARS) { writeValue(editor, readValue(editor) + text); return; }
    insertClip(editor, textClipName(text), text, false);
  };
  const appendContext = (editor, name, text) => {
    insertClip(editor, name, text, true);
  };
  const appendLargeFilePath = (editor, name, absolutePath, bytes) => {
    insertClip(editor, name, '', true, { absolutePath, bytes });
  };
  const expandClips = editor => {
    if (clips.size === 0) return false;
    let value = readValue(editor);
    for (const entry of clips.values()) value = appendEntry(value, entry);
    for (const tray of document.querySelectorAll('[' + TRAY_ATTR + ']')) tray.remove();
    clips.clear();
    writeValue(editor, value);
    return true;
  };

  const readTextFile = async file => {
    if (file.size > MAX_BYTES) throw new Error('粘贴文件超过 8 MB 限制');
    const text = await file.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error('文件 UTF-8 内容超过 8 MB 限制');
    if (text.slice(0, 8192).includes('\0')) return null;
    return text;
  };
  const isBinaryFile = file => {
    const name = file.name || '';
    if (file.type.startsWith('image/') || BINARY_EXTENSIONS.test(name)) return true;
    return /^(?:audio|video|font)\//i.test(file.type) || /^(?:application\/(?:pdf|zip|gzip|x-7z-compressed|x-rar-compressed|java-archive|msdownload)|binary\/)/i.test(file.type);
  };
  const handleFile = async (editor, file) => {
    const name = file.name || 'clipboard-file';
    if (isBinaryFile(file)) return;
    if (file.size > LARGE_FILE_BYTES) {
      const api = window.dshDesktopFiles;
      const absolutePath = api && typeof api.getAbsolutePath === 'function' ? api.getAbsolutePath(file) : '';
      if (typeof absolutePath !== 'string' || absolutePath.length === 0) throw new Error('无法获取大文本文件的绝对路径：' + name);
      appendLargeFilePath(editor, name, absolutePath, file.size);
      return;
    }
    const text = await readTextFile(file);
    if (text !== null) appendContext(editor, name, text);
  };
  const onPaste = event => {
    const editor = editorFromTarget(event.target);
    if (!isChatEditor(editor)) return;
    const items = event.clipboardData && event.clipboardData.items;
    if (!items || busy) return;
    const files = [];
    for (const item of items) if (item.kind === 'file') { const file = item.getAsFile(); if (file) files.push(file); }
    if (files.length === 0) {
      const text = event.clipboardData.getData('text/plain') || '';
      if (Array.from(text).length <= MAX_INLINE_CHARS) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      appendText(editor, text);
      return;
    }
    const textFiles = files.filter(file => !isBinaryFile(file)).slice(0, MAX_FILES);
    if (textFiles.length === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    busy = true;
    Promise.all(textFiles.map(file => handleFile(editor, file))).catch(error => console.error('[dsh file context]', error)).finally(() => { busy = false; });
  };
  const replayKeydown = (event, editor) => {
    const init = { key: 'Enter', code: event.code || 'Enter', bubbles: true, cancelable: true, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey };
    setTimeout(() => {
      replayingSubmit = true;
      try { editor.dispatchEvent(new KeyboardEvent('keydown', init)); }
      finally { replayingSubmit = false; }
    }, 0);
  };
  const replayFormSubmit = event => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    const submitter = event.submitter instanceof HTMLButtonElement || event.submitter instanceof HTMLInputElement ? event.submitter : undefined;
    if (!form) return;
    setTimeout(() => {
      replayingSubmit = true;
      try { form.requestSubmit(submitter); }
      finally { replayingSubmit = false; }
    }, 0);
  };
  const onSubmit = event => {
    if (replayingSubmit) return;
    let editor = null;
    if (event.type === 'keydown') {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      editor = editorFromTarget(event.target);
      if (!isChatEditor(editor)) return;
    } else {
      const form = event.target instanceof HTMLFormElement ? event.target : null;
      editor = findEditor();
      if (!form || !editor || !form.contains(editor)) return;
    }
    if (clips.size === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!expandClips(editor)) return;
    if (event.type === 'keydown') replayKeydown(event, editor); else replayFormSubmit(event);
  };
  window.addEventListener('paste', onPaste, true);
  document.addEventListener('paste', onPaste, true);
  document.addEventListener('keydown', onSubmit, true);
  document.addEventListener('submit', onSubmit, true);
  disposers.push(() => window.removeEventListener('paste', onPaste, true), () => document.removeEventListener('paste', onPaste, true), () => document.removeEventListener('keydown', onSubmit, true), () => document.removeEventListener('submit', onSubmit, true));
  window[key] = { dispose() { for (const dispose of disposers.splice(0)) dispose(); for (const tray of document.querySelectorAll('[' + TRAY_ATTR + ']')) tray.remove(); clips.clear(); delete window[key]; } };
  return { ok: true };
  })();`;
}
