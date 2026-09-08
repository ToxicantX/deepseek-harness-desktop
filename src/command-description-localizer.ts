export const COMMAND_DESCRIPTION_TRANSLATIONS = {
  'Compact older conversation history': '压缩较早的对话历史',
  'Download this Session log as a ZIP archive': '将本会话日志下载为 ZIP 压缩包',
  'record feedback about this session': '记录对此会话的反馈',
  'set or view the goal for a long-running task': '设置或查看长时间运行任务的目标',
  'Switch the permission preset (sandbox mode + approval policy)': '切换权限预设（沙盒模式 + 审批策略）',
  'Enter or leave plan mode': '进入或退出计划模式',
} as const

export function localizeCommandDescription(description: string): string {
  return COMMAND_DESCRIPTION_TRANSLATIONS[description as keyof typeof COMMAND_DESCRIPTION_TRANSLATIONS] ?? description
}

export function createCommandDescriptionLocalizerScript(): string {
  const translations = JSON.stringify(COMMAND_DESCRIPTION_TRANSLATIONS)
  return `(() => {
  'use strict';
  const key = '__dshDesktopCommandDescriptionLocalizer';
  const previous = window[key];
  if (previous && typeof previous.dispose === 'function') previous.dispose();
  const translations = ${translations};
  const optionSelector = 'button[role="option"][id^="dsh-slash-option-command-"]';
  const localizeOption = option => {
    if (!(option instanceof Element) || !option.matches(optionSelector)) return;
    for (const span of option.querySelectorAll('span')) {
      const localized = translations[span.textContent || ''];
      if (localized !== undefined) span.textContent = localized;
    }
  };
  const localizeRoot = root => {
    if (root instanceof Element && root.matches(optionSelector)) localizeOption(root);
    if (root instanceof Element || root instanceof Document) {
      for (const option of root.querySelectorAll(optionSelector)) localizeOption(option);
    }
  };
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'characterData') {
        const option = record.target.parentElement && record.target.parentElement.closest(optionSelector);
        if (option) localizeOption(option);
        continue;
      }
      for (const node of record.addedNodes) localizeRoot(node);
    }
  });
  localizeRoot(document);
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  window[key] = {
    dispose() {
      observer.disconnect();
      delete window[key];
    },
  };
  return { ok: true };
})();`
}
