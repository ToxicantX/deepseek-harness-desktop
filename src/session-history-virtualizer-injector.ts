/**
 * 桌面壳会话历史渲染观测注入器
 *
 * 背景与阶段性结论（实测得出，勿删）：
 * - 首屏数据从 497 条 / 0.78 MB 降到 216 条 / 0.38 MB 后，主线程阻塞反而从约 24s 变成 90s 以上。
 *   => 阻塞时长与数据量不相关，不是“渲染太慢”，而是某个自激循环。
 * - 全程没有任何 longtask 记录，说明它不是单个长任务，而是海量短任务持续刷满主线程。
 *
 * 因此这里默认不注入任何会改变布局的 CSS，也不做任何定时 DOM 改写，
 * 只保留只读观测能力。用一次干净运行来确认：问题是否由本注入器自身引起。
 */
export function createSessionHistoryVirtualizerScript(): string {
  return `(() => {
  'use strict';
  const KEY = '__dshDesktopSessionVirtualizer';
  if (window[KEY]) return;

  const ENABLE_LAYOUT_TWEAKS = false;
  const report = (message) => {
    try { console.log('[DSH-FRONTEND] ' + message); } catch (error) {}
  };

  report('观测注入器已加载（布局改写：' + (ENABLE_LAYOUT_TWEAKS ? '开启' : '关闭') + '）');

  // 1) 长任务探针。
  try {
    const longTasks = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < 200) continue;
        report('longtask ' + Math.round(entry.duration) + ' ms | ' + (entry.name || 'unknown'));
      }
    });
    longTasks.observe({ entryTypes: ['longtask'] });
    window[KEY + 'LongTasks'] = longTasks;
  } catch (error) {
    report('longtask 探针不可用: ' + String(error));
  }

  // 2) 主线程心跳采样：连续多帧未推进即说明被同步任务占满。
  let lastBeat = performance.now();
  let stalledReports = 0;
  const beat = () => {
    const now = performance.now();
    const delta = now - lastBeat;
    if (delta > 1500 && stalledReports < 20) {
      stalledReports += 1;
      report('main thread stalled ' + Math.round(delta) + ' ms (heartbeat gap)');
    }
    lastBeat = now;
    requestAnimationFrame(beat);
  };
  requestAnimationFrame(beat);

  // 3) 只读统计：观察聊天流里到底挂了多少节点，用来判断渲染规模。
  const summarize = () => {
    try {
      const flow = document.querySelector('[data-chat-flow]');
      if (flow === null) return;
      const pres = flow.querySelectorAll('pre, code').length;
      const rows = flow.children.length;
      report('flow rows=' + rows + ' pre/code=' + pres + ' nodes=' + flow.querySelectorAll('*').length);
    } catch (error) {}
  };
  setTimeout(summarize, 3000);
  setTimeout(summarize, 8000);

  // 4) 仅在显式开启时才做布局收紧（历史上怀疑它会与 DSH 的 ResizeObserver 互相激发）。
  if (ENABLE_LAYOUT_TWEAKS) {
    const STYLE_ID = 'dsh-session-history-virtualizer-style';
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = ${JSON.stringify([
        'pre:not([data-dsh-expanded]), code:not([data-dsh-expanded]) { max-height: 520px; overflow-y: auto !important; }',
        '[data-chat-flow] { contain: style; }',
      ].join(' '))};
      (document.head || document.documentElement).appendChild(style);
    }
  }

  window[KEY] = {
    enableLayoutTweaks() {
      report('运行时开启布局收紧');
      const style = document.createElement('style');
      style.id = 'dsh-session-history-virtualizer-style';
      style.textContent = ${JSON.stringify([
        'pre:not([data-dsh-expanded]), code:not([data-dsh-expanded]) { max-height: 520px; overflow-y: auto !important; }',
        '[data-chat-flow] { contain: style; }',
      ].join(' '))};
      (document.head || document.documentElement).appendChild(style);
    },
    summarize,
    dispose() {
      try { window[KEY + 'LongTasks']?.disconnect(); } catch (error) {}
      const style = document.getElementById('dsh-session-history-virtualizer-style');
      if (style) style.remove();
      delete window[KEY];
    }
  };
})();`
}
