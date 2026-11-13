/**
 * 未读角标 · client half
 *
 * 两件事，数据都来自宿主已有的"未读"事实，不自己记账：
 *
 *   ① Dock 数字角标 —— 未读（完成的回复没打开过）+ 出错 的会话数，用
 *      `navigator.setAppBadge()` 写到应用图标上。Electron 44 的 renderer 有
 *      这套 API（blink::NavigatorBadge → Electron BadgeManager → NSDockTile），
 *      宿主进程碰不到 Dock，所以只能在这一层做。
 *
 *   ② 工作区提醒点 —— DSH 侧栏没有"工作区标题行"的插槽（只有会话行的
 *      `sidebar.session.row.*` 那一组），所以这里用 DOM 补一层：找到
 *      `[data-row-key="workspace:<id>"]` 那一行，在行尾（hover 动作按钮之前）
 *      插一个 7px 圆点。工作区折叠起来时标题行还在，点就还在——这正是需求。
 *
 * 事实来源：
 *   - `uiSession.sessionStatus` → Map<id, {running, pendingInteraction, completionUnread}>
 *   - `sessions.list`           → 会话行摘要（running / retainedBy.mainView / origin）
 *   - `uiWorkspace.workspaces.list` → 工作区 → 会话 id 的归属
 *   - `remote.$on('api-session/error')` → 失败（宿主不保留失败的未读位，只能事件驱动自己记）
 *
 * 颜色优先级：红（出错）> 绿（完成未读）> 蓝（还在跑，可关）。
 */

window.__ModuleLoader__.load({
  id: '@feifan/dsh-unread-badge',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;

    const NS = 'unreadBadge';
    const PREFS_KEY = 'dsh-unread-badge:prefs';
    const STYLE_ID = 'dsh-unread-badge-style';
    const DOT_ATTR = 'data-dsh-unread-dot';
    const ROW_SELECTOR = '[data-row-key^="workspace:"]';
    const ROW_PREFIX = 'workspace:';

    const DEFAULTS = { dock: true, dots: true, running: true };

    // ── 偏好（只存本地，不进 profile） ───────────────────────────────
    function readPrefs() {
      try {
        const raw = window.localStorage.getItem(PREFS_KEY);
        if (!raw) return Object.assign({}, DEFAULTS);
        const parsed = JSON.parse(raw);
        const next = Object.assign({}, DEFAULTS);
        for (const key of Object.keys(DEFAULTS)) {
          if (typeof parsed[key] === 'boolean') next[key] = parsed[key];
        }
        return next;
      } catch (error) {
        return Object.assign({}, DEFAULTS);
      }
    }

    function writePrefs(next) {
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch (error) {
        /* 无痕模式 / 存储不可用时保持内存态 */
      }
    }

    let prefs = readPrefs();

    // ── 样式 ────────────────────────────────────────────────────────
    const CSS = `
      [${DOT_ATTR}]{
        display:none;flex:none;width:7px;height:7px;border-radius:50%;
        margin-inline-start:6px;pointer-events:none;
        transition:background-color .15s ease,box-shadow .15s ease;
      }
      [${DOT_ATTR}][data-tone="unread"]{display:inline-block;background:#22c55e;box-shadow:0 0 0 2px rgba(34,197,94,.18)}
      [${DOT_ATTR}][data-tone="error"]{display:inline-block;background:#ef4444;box-shadow:0 0 0 2px rgba(239,68,68,.18)}
      [${DOT_ATTR}][data-tone="running"]{display:inline-block;background:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.16);animation:dshub-breathe 1.9s ease-in-out infinite}
      @keyframes dshub-breathe{0%,100%{opacity:1}50%{opacity:.35}}
      @media (prefers-reduced-motion: reduce){[${DOT_ATTR}]{animation:none!important}}

      .dshub_row{display:flex;flex-direction:column;gap:10px;padding:2px 0}
      .dshub_head{display:flex;flex-direction:column;gap:2px}
      .dshub_title{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary)}
      .dshub_desc{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
      .dshub_line{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:32px}
      .dshub_label{display:flex;flex-direction:column;gap:1px}
      .dshub_name{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary)}
      .dshub_hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
      .dshub_switch{position:relative;flex:none;width:34px;height:20px;border-radius:999px;border:none;padding:0;cursor:pointer;
        background:var(--dsw-alias-interactive-bg-secondary,rgba(127,127,127,.28));transition:background-color .15s ease}
      .dshub_switch[data-on="1"]{background:var(--dsw-alias-brand-fill,#4d6bfe)}
      .dshub_knob{position:absolute;top:2px;left:2px;display:block;width:16px;height:16px;border-radius:50%;background:#fff;
        transition:transform .15s ease;box-shadow:0 1px 2px rgba(0,0,0,.2)}
      .dshub_switch[data-on="1"] .dshub_knob{transform:translateX(14px)}
      .dshub_legend{display:flex;flex-wrap:wrap;gap:10px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
      .dshub_key{display:inline-flex;align-items:center;gap:5px}
      .dshub_swatch{display:inline-block;width:7px;height:7px;border-radius:50%}
      .dshub_note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
      .dshub_note[data-warn="1"]{color:var(--dsw-alias-label-warning,#f59e0b)}
    `;

    // ── 文案 ────────────────────────────────────────────────────────
    const ZH = {
      title: '未读提醒',
      desc: 'Dock 图标显示未读数字；工作区折叠时，标题行右侧用颜色点提示组内状态。',
      dock: 'Dock 数字角标',
      dockHint: '完成的回复没打开过、或这一轮出错，都算一个未读。',
      dots: '工作区提醒点',
      dotsHint: '点在每个工作区标题行右侧，折叠时也可见。',
      running: '也在运行的会话上显示蓝点',
      runningHint: '关掉后只提示未读与出错。',
      legendUnread: '完成未读',
      legendError: '出错',
      legendRunning: '运行中',
      unsupported: '当前环境不支持 Dock 角标（网页版需安装为 PWA 才生效）。',
    };

    const EN = {
      title: 'Unread badge',
      desc: 'A number on the Dock icon for replies you have not opened, plus a coloured dot on each Workspace row so a collapsed group still tells you something happened there.',
      dock: 'Dock number badge',
      dockHint: 'An unopened finished reply, or a failed run, counts as one unread.',
      dots: 'Workspace dots',
      dotsHint: 'A dot at the right edge of every Workspace row; visible while collapsed.',
      running: 'Show a blue dot for running sessions',
      runningHint: 'Turn off to only surface unread and failed work.',
      legendUnread: 'Finished, unread',
      legendError: 'Failed',
      legendRunning: 'Running',
      unsupported: 'This environment cannot write a Dock badge (the web build needs to be installed as a PWA).',
    };

    // ── 状态 ────────────────────────────────────────────────────────
    /** sessionId -> 最近的失败信息（宿主不保留失败的未读位，这里自己盯着，打开会话即清） */
    const errors = new Map();
    /** workspaceKey -> { unread, error, running }，给 DOM 层用 */
    let aggregates = new Map();
    let badgeCount = 0;
    let lastBadge = -1;
    let dotRaf = 0;
    let disposed = false;
    /** apply() 装好之后由设置页调用：偏好变了立刻重算 */
    let refresh = function () {};
    let badgeSupported = false;

    /** 主页正在显示这个会话 = 已读（宿主自己也会把 completionUnread 清掉）。 */
    function isViewed(summary) {
      if (!summary || !summary.retainedBy) return false;
      const mainView = summary.retainedBy.mainView;
      return typeof mainView === 'number' && mainView > 0;
    }

    function isSubagent(summary) {
      return !!summary && summary.origin === 'subagent';
    }

    // ── 核心：重算聚合 ──────────────────────────────────────────────
    function buildAggregates(ctx) {
      let list;
      let statuses;
      let workspaces;
      try { list = ctx.sessions.list.getSnapshot(); } catch (error) { list = undefined; }
      try { statuses = ctx.uiSession.sessionStatus.getSnapshot(); } catch (error) { statuses = undefined; }
      try { workspaces = ctx.uiWorkspace.workspaces.list.getSnapshot(); } catch (error) { workspaces = undefined; }

      const byId = (list && list.byId) || {};
      const ids = Array.isArray(list && list.ids) ? list.ids : Object.keys(byId);

      // 打开会话 = 已读：宿主会自己清 completionUnread，失败得我们自己清。
      for (const sessionId of Array.from(errors.keys())) {
        const summary = byId[sessionId];
        if (summary === undefined && list && list.phase === 'ready') { errors.delete(sessionId); continue; }
        if (isViewed(summary)) errors.delete(sessionId);
      }

      const facts = new Map();
      let unread = 0;

      for (const sessionId of ids) {
        const summary = byId[sessionId];
        if (summary === undefined) continue;
        if (isSubagent(summary)) continue;

        let status;
        try { status = statuses && typeof statuses.get === 'function' ? statuses.get(sessionId) : undefined; } catch (error) { status = undefined; }

        // 新一轮开始跑，上一次的失败就不再算未读。
        if (status && status.running === true && errors.has(sessionId)) errors.delete(sessionId);

        const fact = {
          running: (status && status.running === true) || summary.running === true,
          unread: (status && status.completionUnread === true) || summary.completed === true,
          error: errors.has(sessionId),
        };
        facts.set(sessionId, fact);
        if (fact.unread || fact.error) unread += 1;
      }

      const next = new Map();
      const slot = (key) => {
        if (!next.has(key)) next.set(key, { unread: 0, error: 0, running: 0 });
        return next.get(key);
      };
      const accounted = new Set();

      const items = (workspaces && Array.isArray(workspaces.items)) ? workspaces.items : [];
      for (const item of items) {
        const key = item && item.workspaceId !== undefined ? String(item.workspaceId) : '';
        const memberIds = item && Array.isArray(item.sessionIds) ? item.sessionIds : [];
        if (memberIds.length === 0) continue;
        for (const sessionId of memberIds) {
          accounted.add(sessionId);
          const fact = facts.get(sessionId);
          if (fact === undefined) continue;
          const bucket = slot(key);
          if (fact.unread) bucket.unread += 1;
          if (fact.error) bucket.error += 1;
          if (fact.running) bucket.running += 1;
        }
      }

      // 没有被任何工作区认领的会话归到「未分组」那一行（data-row-key="workspace:"）
      for (const sessionId of facts.keys()) {
        if (accounted.has(sessionId)) continue;
        const fact = facts.get(sessionId);
        const bucket = slot('');
        if (fact.unread) bucket.unread += 1;
        if (fact.error) bucket.error += 1;
        if (fact.running) bucket.running += 1;
      }

      return { aggregates: next, unread };
    }

    // ── ① Dock 角标 ────────────────────────────────────────────────
    function applyDockBadge(count) {
      if (!badgeSupported) return;
      const target = prefs.dock ? count : 0;
      if (target === lastBadge) return;
      lastBadge = target;
      try {
        if (target > 0) void navigator.setAppBadge(target);
        else void navigator.clearAppBadge();
      } catch (error) {
        /* 不支持就只是没有角标，其余功能照常 */
      }
    }

    // ── ② 工作区圆点 ────────────────────────────────────────────────
    function scheduleDots() {
      if (disposed || dotRaf !== 0) return;
      dotRaf = window.requestAnimationFrame(() => {
        dotRaf = 0;
        syncDots();
      });
    }

    function ensureDot(row) {
      let dot = null;
      for (const child of row.children) {
        if (child.hasAttribute && child.hasAttribute(DOT_ATTR)) { dot = child; break; }
      }
      if (dot !== null) return dot;
      dot = document.createElement('span');
      dot.setAttribute(DOT_ATTR, '');
      dot.setAttribute('aria-hidden', 'true');
      const actions = row.lastElementChild;
      if (actions !== null && actions !== dot && actions.hasAttribute && actions.hasAttribute(DOT_ATTR) === false) {
        row.insertBefore(dot, actions);
      } else {
        row.appendChild(dot);
      }
      return dot;
    }

    function paintDot(dot, bucket) {
      let tone = '';
      if (bucket) {
        if (bucket.error > 0) tone = 'error';
        else if (bucket.unread > 0) tone = 'unread';
        else if (prefs.running && bucket.running > 0) tone = 'running';
      }
      if (tone === '') {
        if (dot.getAttribute('data-tone') !== null) dot.removeAttribute('data-tone');
        dot.style.display = 'none';
        return;
      }
      dot.style.display = '';
      if (dot.getAttribute('data-tone') !== tone) dot.setAttribute('data-tone', tone);
    }

    function syncDots() {
      if (disposed) return;
      const rows = document.querySelectorAll(ROW_SELECTOR);
      if (!prefs.dots) {
        for (const row of rows) {
          for (const child of Array.from(row.children)) {
            if (child.hasAttribute && child.hasAttribute(DOT_ATTR)) child.remove();
          }
        }
        return;
      }
      for (const row of rows) {
        const key = (row.getAttribute('data-row-key') || '').slice(ROW_PREFIX.length);
        paintDot(ensureDot(row), aggregates.get(key));
      }
    }

    function removeAllDots() {
      for (const dot of document.querySelectorAll('[' + DOT_ATTR + ']')) dot.remove();
    }

    // ── 重算入口 ────────────────────────────────────────────────────
    function recompute(ctx) {
      if (disposed) return;
      let result;
      try {
        result = buildAggregates(ctx);
      } catch (error) {
        return;
      }
      aggregates = result.aggregates;
      badgeCount = result.unread;
      applyDockBadge(badgeCount);
      scheduleDots();
    }

    // ── 设置页的一行 ────────────────────────────────────────────────
    function Switch(props) {
      return h('button', {
        type: 'button',
        className: 'dshub_switch',
        role: 'switch',
        'aria-checked': props.on ? 'true' : 'false',
        'data-on': props.on ? '1' : '0',
        title: props.label,
        onClick: props.onClick,
      }, h('span', { className: 'dshub_knob' }, null));
    }

    function SettingsRow(props) {
      const t = typeof props.t === 'function' ? props.t
        : typeof props.translate === 'function' ? props.translate
        : (key) => key;
      const [state, setState] = React.useState(prefs);

      const set = (key) => {
        const next = Object.assign({}, prefs);
        next[key] = !next[key];
        prefs = next;
        writePrefs(next);
        setState(next);
        refresh();
      };

      const line = (key, name, hint) => h('div', { className: 'dshub_line', key: key }, [
        h('div', { className: 'dshub_label', key: 'text' }, [
          h('div', { className: 'dshub_name', key: 'name' }, t(name)),
          h('div', { className: 'dshub_hint', key: 'hint' }, t(hint)),
        ]),
        h(Switch, {
          key: 'switch',
          on: state[key] === true,
          label: t(name),
          onClick: () => set(key),
        }),
      ]);

      const swatch = (color, label) => h('span', { className: 'dshub_key', key: label }, [
        h('span', { className: 'dshub_swatch', key: 'dot', style: { background: color } }, null),
        h('span', { key: 'text' }, t(label)),
      ]);

      return h('div', { className: 'dshub_row' }, [
        h('div', { className: 'dshub_head', key: 'head' }, [
          h('div', { className: 'dshub_title', key: 'title' }, t('title')),
          h('div', { className: 'dshub_desc', key: 'desc' }, t('desc')),
        ]),
        line('dock', 'dock', 'dockHint'),
        line('dots', 'dots', 'dotsHint'),
        line('running', 'running', 'runningHint'),
        h('div', { className: 'dshub_legend', key: 'legend' }, [
          swatch('#22c55e', 'legendUnread'),
          swatch('#ef4444', 'legendError'),
          swatch('#3b82f6', 'legendRunning'),
        ]),
        badgeSupported ? null : h('div', { className: 'dshub_note', 'data-warn': '1', key: 'note' }, t('unsupported')),
      ]);
    }

    // ── 插件体 ──────────────────────────────────────────────────────
    const inject = ['sessions', 'uiSession', 'uiWorkspace', 'locale', 'slots'];

    function apply(ctx) {
      disposed = false;
      badgeSupported = typeof navigator !== 'undefined' && typeof navigator.setAppBadge === 'function';
      refresh = () => recompute(ctx);

      // 样式与 DOM 观察
      ctx.effect(() => {
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.setAttribute('data-plugin', 'dsh-unread-badge');
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);

        const observer = new MutationObserver(() => scheduleDots());
        observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('resize', scheduleDots);
        scheduleDots();

        return () => {
          observer.disconnect();
          window.removeEventListener('resize', scheduleDots);
          style.remove();
          removeAllDots();
        };
      }, 'dsh-unread-badge: stylesheet and row dots');

      // 宿主事实：会话状态 + 会话列表 + 工作区归属
      ctx.effect(() => {
        const disposers = [];
        try { disposers.push(ctx.uiSession.sessionStatus.subscribe(refresh)); } catch (error) { /* 老宿主没有这个 store */ }
        try { disposers.push(ctx.sessions.list.subscribe(refresh)); } catch (error) { /* 列表不可订阅时靠下面的定时兜底 */ }
        try {
          const workspaceList = ctx.uiWorkspace && ctx.uiWorkspace.workspaces && ctx.uiWorkspace.workspaces.list;
          if (workspaceList && typeof workspaceList.subscribe === 'function') disposers.push(workspaceList.subscribe(refresh));
        } catch (error) { /* 工作区注册表没有 subscribe 就等状态变化再算 */ }
        refresh();
        const timer = window.setInterval(refresh, 2500);
        return () => {
          window.clearInterval(timer);
          for (const dispose of disposers) {
            try { dispose(); } catch (error) { /* 已销毁 */ }
          }
        };
      }, 'dsh-unread-badge: facts');

      // 失败事件：宿主只在事件里给，自己记到「打开会话」为止
      ctx.effect(() => {
        let remote;
        try { remote = typeof ctx.get === 'function' ? ctx.get('remote') : ctx.remote; } catch (error) { remote = ctx.remote; }
        if (!remote || typeof remote.$on !== 'function') return;
        const off = remote.$on('api-session/error', (sessionId, message) => {
          if (typeof sessionId !== 'string' || sessionId === '') return;
          let summary;
          try { summary = ctx.sessions.list.getSnapshot().byId[sessionId]; } catch (error) { summary = undefined; }
          if (isSubagent(summary)) return;
          if (isViewed(summary)) return;
          errors.set(sessionId, typeof message === 'string' ? message : '');
          refresh();
        });
        return () => {
          try { if (typeof off === 'function') off(); } catch (error) { /* 已销毁 */ }
        };
      }, 'dsh-unread-badge: failure watch');

      // 设置 → 通用 里的一行
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-unread-badge: dictionaries');
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'unreadBadge',
        order: 7,
        locale: NS,
        inject: () => ({ t: ctx.locale.bind(NS) }),
      }, SettingsRow));

      // 调试口，和 notify-me 的 __dshNotifyMe 一个路数
      window.__dshUnreadBadge = {
        state: () => ({
          badgeCount,
          badgeSupported,
          dock: prefs.dock,
          dots: prefs.dots,
          running: prefs.running,
          errors: Array.from(errors.keys()),
          workspaces: Array.from(aggregates.entries()).map(([key, value]) => ({ key, ...value })),
        }),
        refresh: () => refresh(),
        prefs: () => Object.assign({}, prefs),
      };

      // 卸载时把角标和点收干净
      ctx.effect(() => () => {
        disposed = true;
        try { if (badgeSupported) void navigator.clearAppBadge(); } catch (error) { /* ignore */ }
        removeAllDots();
      }, 'dsh-unread-badge: teardown');
    }

    return { inject, apply };
  },
});
