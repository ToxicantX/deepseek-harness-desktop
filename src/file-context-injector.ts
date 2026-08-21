export function createFileContextInjectorScript(): string {
  return String.raw`(() => {
  'use strict';
  const key = '__dshDesktopFileContext';
  const previous = window[key];
  if (previous && typeof previous.dispose === 'function') previous.dispose();
  const MAX_BYTES = 8 * 1024 * 1024;
  const TEXT_EXTENSIONS = /\.(?:txt|md|markdown|json|yaml|yml|csv|log|xml|html|css|js|jsx|ts|tsx|py|java|go|rs|c|cpp|h|hpp|toml|ini|conf|sql|sh|bat|ps1)$/i;
  const disposers = [];
  let busy = false;
  const findEditor = () => [...document.querySelectorAll('textarea,[contenteditable="true"]')].find(node => node instanceof HTMLElement && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0) || null;
  const readValue = node => node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement ? node.value : node.innerText;
  const writeValue = (node, value) => {
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value');
      if (descriptor && descriptor.set) descriptor.set.call(node, value); else node.value = value;
    } else node.innerText = value;
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
  };
  const appendContext = (name, text) => {
    const editor = findEditor();
    if (!editor) throw new Error('未找到 DSH 对话输入框');
    const marker = '--- 用户粘贴文件：' + name + ' ---';
    const current = readValue(editor);
    if (current.includes(marker)) return;
    writeValue(editor, current + '\n\n' + marker + '\n' + text + '\n--- 用户粘贴文件结束 ---');
  };
  const readTextFile = async file => {
    if (file.size > MAX_BYTES) throw new Error('粘贴文件超过 8 MB 限制');
    const text = await file.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error('文件 UTF-8 内容超过 8 MB 限制');
    return text;
  };
  const handleFile = async file => {
    const name = file.name || (file.type.startsWith('image/') ? 'clipboard-image' : 'clipboard-file');
    if (file.type.startsWith('image/')) {
      const api = window.dshDesktopOcr;
      if (!api || typeof api.recognize !== 'function') throw new Error('图片识别桥接不可用');
      const text = await api.recognize(await file.arrayBuffer());
      appendContext(name, '[图片 OCR 识别结果]\n' + (text || '未识别到文字'));
      return;
    }
    if (!TEXT_EXTENSIONS.test(name) && !file.type.startsWith('text/')) throw new Error('暂不支持自动读取此类粘贴文件：' + name);
    appendContext(name, await readTextFile(file));
  };
  const onPaste = event => {
    const items = event.clipboardData && event.clipboardData.items;
    if (!items || busy) return;
    const files = [];
    for (const item of items) if (item.kind === 'file') { const file = item.getAsFile(); if (file) files.push(file); }
    if (files.length === 0) {
      const text = event.clipboardData.getData('text/plain') || '';
      if (text.length < 20_000) return;
      event.preventDefault();
      appendContext('pasted-text.txt', text);
      return;
    }
    event.preventDefault();
    busy = true;
    Promise.all(files.map(handleFile)).catch(error => console.error('[dsh file context]', error)).finally(() => { busy = false; });
  };
  document.addEventListener('paste', onPaste, true);
  disposers.push(() => document.removeEventListener('paste', onPaste, true));
  window[key] = { dispose() { for (const dispose of disposers.splice(0)) dispose(); delete window[key]; } };
  return { ok: true };
  })();`;
}
