/**
 * 未读角标 · client half（0.3.0）
 *
 * 同一份事实，五处呈现：
 *
 *   ① Dock 数字角标 —— 未读（完成的回复没打开过）+ 出错 的会话数，用
 *      `navigator.setAppBadge()` 写到应用图标上。Electron 44 的 renderer 有
 *      这套 API（blink::NavigatorBadge → Electron BadgeManager → NSDockTile），
 *      宿主进程碰不到 Dock，所以只能在这一层做。
 *
 *   ② 侧栏底部「任务」面板 —— 注册进 `sidebar.footer.action` 席位（和
 *      「自动化任务」同门）：常驻一行显示 进行中 / 卡住 / 完成 的计数，
 *      点开向上弹出分组列表，点任一行直接进对应会话。
 *
 *   ③ 工作区提醒点 —— DSH 侧栏没有"工作区标题行"的插槽（只有会话行的
 *      `sidebar.session.row.*` 那一组），所以这里用 DOM 补一层：找到
 *      `[data-row-key="workspace:<id>"]` 那一行，在行尾（hover 动作按钮之前）
 *      插一个 7px 圆点。工作区折叠起来时标题行还在，点就还在。
 *
 *   ④ 侧栏收起时的悬浮球 —— 注册进 `shell.overlay`（横跨整个窗口、在所有
 *      列之上的浮层）。侧栏收起后它停在窗口左边缘，点开就是同一个任务
 *      面板，不用先把侧栏展开。可以上下拖动，位置记在本地。侧栏收起成
 *      56px 图标条时它会自动让开那条竖条，停在竖条右侧。
 *
 *   ⑤ 历史 —— 自动记下你最近真正打开过的 3 个会话（看 `retainedBy.mainView`，
 *      从侧栏点、从历史点、从任何地方跳过去都算），存在本地，刷新不丢。
 *      只显示当前不在「卡住/失败/进行中/完成」里的那几条，避免和上面重复；
 *      每条可以手动隐藏，也可以一键清空。
 *
 * 事实来源（全部只读，不自己记账，失败除外）：
 *   - `uiSession.sessionStatus` → Map<id, {running, pendingInteraction, completionUnread}>
 *   - `sessions.list`           → 会话行摘要（title / running / retainedBy.mainView / origin）
 *   - `uiWorkspace.workspaces.list` → 工作区 → 会话 id 的归属与工作区名
 *   - `remote.$on('api-session/error')` → 失败（宿主不保留失败的未读位，只能事件驱动自己记）
 *
 * 状态优先级：卡住（等你）> 失败 > 运行中 > 完成未读。
 */

window.__ModuleLoader__.load({
  id: '@fanfan4589/dsh-unread-badge',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;

    const NS = 'unreadBadge';
    const PREFS_KEY = 'dsh-unread-badge:prefs';
    const HISTORY_KEY = 'dsh-unread-badge:history';
    const FLOAT_KEY = 'dsh-unread-badge:float-top';
    const STYLE_ID = 'dsh-unread-badge-style';
    const DOT_ATTR = 'data-dsh-unread-dot';
    const ROW_SELECTOR = '[data-row-key^="workspace:"]';
    const ROW_PREFIX = 'workspace:';
    const PANEL_LIMIT = 30;
    /** 历史只留 3 条：不增加，够回到刚才待过的地方就行。 */
    const HISTORY_LIMIT = 3;

    const DEFAULTS = { dock: true, dots: true, running: true, panel: true, float: true, history: true };

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

    // ── 历史（最近待过的 3 个会话） ──────────────────────────────────
    /** [{ id, at }]，越靠前越新；只存会话 id 和时间，标题从宿主实况里取。 */
    function readHistory() {
      try {
        const raw = window.localStorage.getItem(HISTORY_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const next = [];
        for (const entry of parsed) {
          if (next.length >= HISTORY_LIMIT) break;
          if (!entry || typeof entry.id !== 'string' || entry.id === '') continue;
          if (next.some((item) => item.id === entry.id)) continue;
          next.push({
            id: entry.id,
            at: typeof entry.at === 'number' && entry.at > 0 ? entry.at : 0,
          });
        }
        return next;
      } catch (error) {
        return [];
      }
    }

    function writeHistory(next) {
      try {
        window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch (error) {
        /* 存储不可用时只保留本次内存里的历史 */
      }
    }

    let history = readHistory();
    /** 上一次记录过的"当前会话"，只有真的换到别的会话才写历史。 */
    let lastCurrentId = '';

    function sameHistory(left, right) {
      if (left.length !== right.length) return false;
      for (let index = 0; index < left.length; index += 1) {
        if (left[index].id !== right[index].id || left[index].at !== right[index].at) return false;
      }
      return true;
    }

    function rememberVisit(sessionId) {
      if (!prefs.history || typeof sessionId !== 'string' || sessionId === '') return;
      const next = [{ id: sessionId, at: Date.now() }]
        .concat(history.filter((entry) => entry.id !== sessionId))
        .slice(0, HISTORY_LIMIT);
      if (sameHistory(next, history)) return;
      history = next;
      writeHistory(next);
    }

    function forgetVisit(sessionId) {
      const next = history.filter((entry) => entry.id !== sessionId);
      if (sameHistory(next, history)) return;
      history = next;
      writeHistory(next);
    }

    function clearHistory() {
      if (history.length === 0) return;
      // 保留 lastCurrentId：清空后不要马上把"当前会话"又写回来，
      // 等你真的切到另一个会话，历史才重新开始记。
      history = [];
      writeHistory(history);
      refresh();
    }

    // ── 悬浮球位置（像素；只在本地） ────────────────────────────────
    function readFloatTop() {
      try {
        const raw = window.localStorage.getItem(FLOAT_KEY);
        if (raw === null) return undefined;
        const value = Number(raw);
        return Number.isFinite(value) && value >= 0 ? value : undefined;
      } catch (error) {
        return undefined;
      }
    }

    function writeFloatTop(value) {
      try {
        window.localStorage.setItem(FLOAT_KEY, String(Math.round(value)));
      } catch (error) {
        /* ignore */
      }
    }

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

      /* ── 侧栏底部：任务触发行 + 弹层 ── */
      .dshub_foot{position:relative;display:flex;flex-direction:column;flex:none;padding:0 8px}
      .dshub_trigger{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 8px;border:none;background:transparent;
        border-radius:8px;cursor:pointer;text-align:start;color:var(--dsw-alias-label-secondary,#4b5563);font:inherit}
      .dshub_trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
      .dshub_trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
      .dshub_triggerIcon{flex:none;display:inline-flex;color:currentColor;opacity:.9}
      .dshub_triggerLabel{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:13px;line-height:18px}
      .dshub_triggerCount{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);
        font-variant-numeric:tabular-nums;letter-spacing:.2px}
      .dshub_footRail{padding:0}
      .dshub_footRail .dshub_trigger{width:36px;height:36px;padding:0;margin:0 auto;justify-content:center;gap:0}
      .dshub_footRail .dshub_triggerLabel{display:none}
      .dshub_footRail .dshub_triggerCount{position:absolute;transform:translate(11px,-9px);font-size:10px}

      .dshub_panel{pointer-events:auto;position:fixed;z-index:60;width:320px;max-height:min(60vh,520px);overflow:auto;padding:6px;
        background:var(--dsw-specific-sidebar-fill,#fff);color:var(--dsw-alias-label-primary,#111);
        border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.22));border-radius:12px;
        box-shadow:0 12px 32px rgba(0,0,0,.18);box-sizing:border-box}
      .dshub_panelHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px 8px}
      .dshub_panelTitle{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-weight:600;letter-spacing:.02em}
      .dshub_group{margin-top:6px}
      .dshub_groupHead{display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:11px;line-height:15px;
        color:var(--dsw-alias-label-tertiary)}
      .dshub_groupCount{font-variant-numeric:tabular-nums}
      .dshub_task{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:none;background:transparent;
        border-radius:8px;cursor:pointer;text-align:start;font:inherit;color:inherit}
      .dshub_task:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
      .dshub_task:focus-visible{outline:2px solid var(--dsw-alias-brand-fill,#4d6bfe);outline-offset:1px}
      .dshub_state{flex:none;width:7px;height:7px;border-radius:50%}
      .dshub_state[data-state="blocked"]{background:#f59e0b}
      .dshub_state[data-state="running"]{background:#3b82f6;animation:dshub-breathe 1.9s ease-in-out infinite}
      .dshub_state[data-state="failed"]{background:#ef4444}
      .dshub_state[data-state="done"]{background:#22c55e}
      .dshub_taskMain{display:flex;flex-direction:column;min-width:0;flex:1}
      .dshub_taskTitle{font-size:13px;line-height:18px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
      .dshub_taskMeta{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);
        overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
      .dshub_taskTime{flex:none;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);
        font-variant-numeric:tabular-nums}
      .dshub_empty{padding:14px 10px 16px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary);text-align:center}
      .dshub_more{padding:6px 8px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)}

      /* ── 历史：只留最近 3 个，逐条可隐藏 ── */
      .dshub_groupAction{margin-inline-start:auto;border:none;background:transparent;padding:2px 6px;border-radius:6px;
        font:inherit;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
      .dshub_groupAction:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));
        color:var(--dsw-alias-label-primary)}
      .dshub_recent{display:flex;align-items:center;gap:2px;border-radius:8px}
      .dshub_recent:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
      .dshub_recentOpen{display:flex;align-items:center;gap:8px;flex:1;min-width:0;padding:6px 0 6px 8px;border:none;
        background:transparent;cursor:pointer;text-align:start;font:inherit;color:inherit;border-radius:8px 0 0 8px}
      .dshub_recentOpen:focus-visible{outline:2px solid var(--dsw-alias-brand-fill,#4d6bfe);outline-offset:-2px}
      .dshub_clock{flex:none;display:inline-flex;width:7px;height:7px;border-radius:50%;
        border:1.5px solid var(--dsw-alias-label-tertiary,#9ca3af);box-sizing:border-box;opacity:.8}
      .dshub_recentDrop{flex:none;width:22px;height:22px;margin-inline-end:4px;border:none;border-radius:6px;
        background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;line-height:1;font-size:13px;
        opacity:0;transition:opacity .12s ease,background-color .12s ease}
      .dshub_recent:hover .dshub_recentDrop,.dshub_recentDrop:focus-visible{opacity:1}
      .dshub_recentDrop:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));
        color:var(--dsw-alias-label-primary)}

      /* ── 侧栏收起时的悬浮球（shell.overlay） ── */
      .dshub_float{position:fixed;z-index:56;display:flex;align-items:flex-start;pointer-events:none}
      .dshub_floatBtn{pointer-events:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;
        gap:3px;width:30px;min-height:64px;padding:8px 0;border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.24));
        border-inline-start:none;border-radius:0 12px 12px 0;cursor:grab;touch-action:none;
        background:var(--dsw-specific-sidebar-fill,#fff);color:var(--dsw-alias-label-secondary,#4b5563);
        box-shadow:0 4px 14px rgba(0,0,0,.14);transition:width .12s ease,box-shadow .15s ease}
      .dshub_floatBtn:hover{width:34px;box-shadow:0 6px 18px rgba(0,0,0,.2)}
      .dshub_floatBtn:active{cursor:grabbing}
      .dshub_floatBtn[data-tone="error"]{border-inline-start:3px solid #ef4444}
      .dshub_floatBtn[data-tone="blocked"]{border-inline-start:3px solid #f59e0b}
      .dshub_floatBtn[data-tone="done"]{border-inline-start:3px solid #22c55e}
      .dshub_floatBtn[data-tone="running"]{border-inline-start:3px solid #3b82f6}
      .dshub_floatBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-fill,#4d6bfe);outline-offset:2px}
      .dshub_floatIcon{display:inline-flex;opacity:.9}
      .dshub_floatCount{font-size:10px;line-height:12px;font-variant-numeric:tabular-nums;font-weight:600;
        color:var(--dsw-alias-label-secondary,#4b5563)}
      @keyframes dshub-float-in{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:none}}
      .dshub_floatBtn{animation:dshub-float-in .16s ease}
      @media (prefers-reduced-motion: reduce){.dshub_floatBtn{animation:none}}
    `;

    // ── 文案 ────────────────────────────────────────────────────────
    const ZH = {
      title: '未读提醒',
      desc: 'Dock 图标显示未读数字；侧栏底部列出进行中、卡住和刚完成的会话；侧栏收起后左边缘留一个悬浮球；最近待过的 3 个会话留在历史里。',
      dock: 'Dock 数字角标',
      dockHint: '完成的回复没打开过、或这一轮出错，都算一个未读。',
      dots: '工作区提醒点',
      dotsHint: '点在每个工作区标题行右侧，折叠时也可见。',
      running: '也在运行的会话上显示蓝点',
      runningHint: '关掉后只提示未读与出错。',
      panel: '侧栏任务总览',
      panelHint: '在侧栏底部常驻一行：几个在进行、几个卡住、几个完成，点开看明细。',
      float: '侧栏收起时的悬浮球',
      floatHint: '侧栏收起来后，窗口左边缘留一个悬浮入口：不用展开侧栏就能看任务、点回会话，可以上下拖。',
      history: '历史（最近 3 个会话）',
      historyHint: '自动记下你最近待过的 3 个会话，刷新不丢；可以逐条隐藏或一键清空。',
      legendUnread: '完成未读',
      legendError: '出错',
      legendRunning: '运行中',
      unsupported: '当前环境不支持 Dock 角标（网页版需安装为 PWA 才生效）。',
      // 面板
      panelTitle: '任务',
      panelAria: '任务总览',
      groupBlocked: '卡住',
      groupRunning: '进行中',
      groupFailed: '失败',
      groupDone: '完成',
      empty: '现在没有进行中或待处理的任务。',
      kindApproval: '等你审批',
      kindPlan: '等你确认计划',
      kindQuestion: '等你回答',
      countRunning: '{n} 进行',
      countBlocked: '{n} 卡住',
      countFailed: '{n} 失败',
      countDone: '{n} 完成',
      openAria: '打开会话：{name}',
      justNow: '刚刚',
      minutes: '{n} 分钟',
      hours: '{n} 小时',
      days: '{n} 天',
      more: '还有 {n} 条',
      groupHistory: '历史',
      clearHistory: '清空',
      clearHint: '清空历史',
      dropHistory: '隐藏这条',
    };

    const EN = {
      title: 'Unread badge',
      desc: 'A number on the Dock icon for unopened replies, a task row at the bottom of the sidebar, a floating handle on the left edge once the sidebar collapses, and the last three sessions you visited.',
      dock: 'Dock number badge',
      dockHint: 'An unopened finished reply, or a failed run, counts as one unread.',
      dots: 'Workspace dots',
      dotsHint: 'A dot at the right edge of every Workspace row; visible while collapsed.',
      running: 'Show a blue dot for running sessions',
      runningHint: 'Turn off to only surface unread and failed work.',
      panel: 'Task overview in the sidebar',
      panelHint: 'A persistent row above Settings: how many are running, blocked or finished, with a click-through list.',
      float: 'Floating entry while the sidebar is collapsed',
      floatHint: 'A small handle on the left edge stays after the sidebar collapses: open the task panel and jump back without expanding it. Drag it up or down.',
      history: 'History (last 3 sessions)',
      historyHint: 'Automatically remembers the last three sessions you actually visited, persisted across reloads; hide one or clear all.',
      legendUnread: 'Finished, unread',
      legendError: 'Failed',
      legendRunning: 'Running',
      unsupported: 'This environment cannot write a Dock badge (the web build needs to be installed as a PWA).',
      panelTitle: 'Tasks',
      panelAria: 'Task overview',
      groupBlocked: 'Blocked',
      groupRunning: 'Running',
      groupFailed: 'Failed',
      groupDone: 'Done',
      empty: 'Nothing is running or waiting right now.',
      kindApproval: 'Waiting for your approval',
      kindPlan: 'Waiting for plan review',
      kindQuestion: 'Waiting for your answer',
      countRunning: '{n} running',
      countBlocked: '{n} blocked',
      countFailed: '{n} failed',
      countDone: '{n} done',
      openAria: 'Open session: {name}',
      justNow: 'just now',
      minutes: '{n} min',
      hours: '{n} h',
      days: '{n} d',
      more: '{n} more',
      groupHistory: 'Recent',
      clearHistory: 'Clear',
      clearHint: 'Clear recent sessions',
      dropHistory: 'Hide this one',
    };

    // ── 状态 ────────────────────────────────────────────────────────
    /** sessionId -> 最近的失败信息（宿主不保留失败的未读位，这里自己盯着，打开会话即清） */
    const errors = new Map();
    /** sessionId -> 第一次看到它处于该状态的时间，用来显示「跑了多久 / 等了多久」 */
    const runningSince = new Map();
    const blockedSince = new Map();
    /** workspaceKey -> { unread, error, running }，给 DOM 层用 */
    let aggregates = new Map();
    let badgeCount = 0;
    let lastBadge = -1;
    let dotRaf = 0;
    let disposed = false;
    /** apply() 装好之后由设置页调用：偏好变了立刻重算 */
    let refresh = function () {};
    let badgeSupported = false;

    // 任务快照（给侧栏面板的组件用）
    const taskListeners = new Set();
    let taskSnapshot = emptyTasks();
    let taskSignature = '';

    function emptyTasks() {
      return {
        counts: { blocked: 0, running: 0, failed: 0, done: 0 },
        groups: [],
        total: 0,
      };
    }

    function subscribeTasks(listener) {
      taskListeners.add(listener);
      return () => { taskListeners.delete(listener); };
    }

    function publishTasks(next) {
      const ids = [];
      for (const group of next.groups) {
        for (const item of group.items) ids.push(item.id + ':' + item.state);
      }
      // 每分钟放进签名，相对时间才会自己走；其余变化靠 id/state 触发。
      // 三个面板开关也进签名：设置里一改，组件要立刻收到一次重渲染。
      const signature = ids.join('|') + '#'
        + (prefs.panel ? '1' : '0')
        + (prefs.float ? '1' : '0')
        + (prefs.history ? '1' : '0')
        + '#' + Math.floor(Date.now() / 60000);
      if (signature === taskSignature) return;
      taskSignature = signature;
      taskSnapshot = next;
      for (const listener of Array.from(taskListeners)) {
        try { listener(); } catch (error) { /* 一个坏订阅不拖垮其它 */ }
      }
    }

    /** 主页正在显示这个会话 = 已读（宿主自己也会把 completionUnread 清掉）。 */
    function isViewed(summary) {
      if (!summary || !summary.retainedBy) return false;
      const mainView = summary.retainedBy.mainView;
      return typeof mainView === 'number' && mainView > 0;
    }

    function isSubagent(summary) {
      return !!summary && summary.origin === 'subagent';
    }

    function sessionTitle(summary, sessionId) {
      if (summary) {
        const title = typeof summary.title === 'string' ? summary.title.trim() : '';
        if (title !== '') return title;
        const display = typeof summary.displayTitle === 'string' ? summary.displayTitle.trim() : '';
        if (display !== '') return display;
        const name = typeof summary.name === 'string' ? summary.name.trim() : '';
        if (name !== '') return name;
        if (typeof summary.cwd === 'string' && summary.cwd !== '') {
          const parts = summary.cwd.split('/').filter(Boolean);
          if (parts.length > 0) return parts[parts.length - 1];
        }
      }
      return sessionId;
    }

    /** pendingInteraction 的 kind → 面板上那句"卡在哪"。 */
    function pendingKind(status) {
      const pending = status && status.pendingInteraction;
      if (!pending || typeof pending !== 'object') return '';
      const kind = typeof pending.kind === 'string' ? pending.kind : '';
      if (kind === 'approval' || kind === 'plan-review' || kind === 'question') return kind;
      return '';
    }

    /** 一条会话事实 → 面板上的状态；优先级：卡住 > 失败 > 运行中 > 完成未读。 */
    function factState(fact) {
      if (!fact) return '';
      if (fact.kind !== '') return 'blocked';
      if (fact.error) return 'failed';
      if (fact.running) return 'running';
      if (fact.unread) return 'done';
      return '';
    }

    // ── 核心：重算聚合 + 任务快照 ──────────────────────────────────
    function buildSnapshot(ctx) {
      let list;
      let statuses;
      let workspaces;
      try { list = ctx.sessions.list.getSnapshot(); } catch (error) { list = undefined; }
      try { statuses = ctx.uiSession.sessionStatus.getSnapshot(); } catch (error) { statuses = undefined; }
      try { workspaces = ctx.uiWorkspace.workspaces.list.getSnapshot(); } catch (error) { workspaces = undefined; }

      const byId = (list && list.byId) || {};
      const ids = Array.isArray(list && list.ids) ? list.ids : Object.keys(byId);
      const items = (workspaces && Array.isArray(workspaces.items)) ? workspaces.items : [];
      const archived = new Set((workspaces && Array.isArray(workspaces.archivedSessionIds)) ? workspaces.archivedSessionIds : []);

      // 工作区 id → 显示名（没有标题就退回目录名）
      const workspaceNames = new Map();
      const workspaceOf = new Map();
      for (const item of items) {
        const key = item && item.workspaceId !== undefined ? String(item.workspaceId) : '';
        const title = (item && (item.title || item.path)) || '';
        workspaceNames.set(key, String(title).split('/').filter(Boolean).pop() || '');
        for (const sessionId of (item && Array.isArray(item.sessionIds)) ? item.sessionIds : []) {
          workspaceOf.set(sessionId, key);
        }
      }

      // 打开会话 = 已读：宿主会自己清 completionUnread，失败得我们自己清。
      for (const sessionId of Array.from(errors.keys())) {
        const summary = byId[sessionId];
        if (summary === undefined && list && list.phase === 'ready') { errors.delete(sessionId); continue; }
        if (isViewed(summary)) errors.delete(sessionId);
      }

      const now = Date.now();
      const facts = new Map();
      const tasks = [];
      let unread = 0;

      for (const sessionId of ids) {
        const summary = byId[sessionId];
        if (summary === undefined) continue;
        if (isSubagent(summary)) continue;
        if (archived.has(sessionId)) continue;

        let status;
        try { status = statuses && typeof statuses.get === 'function' ? statuses.get(sessionId) : undefined; } catch (error) { status = undefined; }

        // 新一轮开始跑，上一次的失败就不再算未读。
        if (status && status.running === true && errors.has(sessionId)) errors.delete(sessionId);

        const fact = {
          running: (status && status.running === true) || summary.running === true,
          unread: (status && status.completionUnread === true) || summary.completed === true,
          error: errors.has(sessionId),
          kind: pendingKind(status),
        };
        facts.set(sessionId, fact);
        if (fact.unread || fact.error) unread += 1;

        let state = factState(fact);
        if (state === '') {
          runningSince.delete(sessionId);
          blockedSince.delete(sessionId);
          continue;
        }

        if (state === 'running') {
          if (!runningSince.has(sessionId)) runningSince.set(sessionId, now);
          blockedSince.delete(sessionId);
        } else if (state === 'blocked') {
          if (!blockedSince.has(sessionId)) blockedSince.set(sessionId, now);
          runningSince.delete(sessionId);
        } else {
          runningSince.delete(sessionId);
          blockedSince.delete(sessionId);
        }

        const since = state === 'blocked' ? blockedSince.get(sessionId)
          : state === 'running' ? runningSince.get(sessionId)
          : undefined;

        tasks.push({
          id: sessionId,
          title: sessionTitle(summary, sessionId),
          state,
          kind: fact.kind,
          workspace: workspaceNames.get(workspaceOf.get(sessionId) || '') || '',
          since,
          updatedAt: typeof summary.updatedAt === 'string' ? Date.parse(summary.updatedAt) : undefined,
        });
      }

      // 已经消失的会话，清掉计时
      for (const sessionId of Array.from(runningSince.keys())) if (!facts.has(sessionId)) runningSince.delete(sessionId);
      for (const sessionId of Array.from(blockedSince.keys())) if (!facts.has(sessionId)) blockedSince.delete(sessionId);

      // 当前会话 = 主视图正在显示的那个（宿主自己也用 `mainView > 0` 找它）。
      // 只有真的换到另一个会话才记一笔：停在原地、开合面板都不会重复记。
      let currentId = '';
      for (const sessionId of ids) {
        const summary = byId[sessionId];
        if (summary === undefined) continue;
        if (isSubagent(summary) || archived.has(sessionId)) continue;
        if (isViewed(summary)) { currentId = sessionId; break; }
      }
      if (currentId !== '' && currentId !== lastCurrentId) {
        lastCurrentId = currentId;
        rememberVisit(currentId);
      }

      // 会话被删掉或归档后，历史里那一条也一起清掉，免得点进去扑空。
      if (list && list.phase === 'ready') {
        const kept = history.filter((entry) => byId[entry.id] !== undefined && !archived.has(entry.id));
        if (!sameHistory(kept, history)) {
          history = kept;
          writeHistory(kept);
        }
      }

      // 历史里只留"现在不在上面四组里"的：还在等你 / 还在跑的会话，
      // 已经在自己的分组里露脸了，不必在历史里重复一遍。
      const liveIds = new Set(tasks.map((task) => task.id));
      const recent = [];
      for (const entry of history) {
        if (recent.length >= HISTORY_LIMIT) break;
        if (liveIds.has(entry.id)) continue;
        const summary = byId[entry.id];
        if (summary === undefined) continue;
        recent.push({
          id: entry.id,
          title: sessionTitle(summary, entry.id),
          state: 'recent',
          kind: '',
          workspace: workspaceNames.get(workspaceOf.get(entry.id) || '') || '',
          since: entry.at,
          updatedAt: entry.at,
        });
      }

      // 工作区聚合（给折叠圆点）
      const next = new Map();
      const slot = (key) => {
        if (!next.has(key)) next.set(key, { unread: 0, error: 0, running: 0 });
        return next.get(key);
      };
      const accounted = new Set();
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
      for (const sessionId of facts.keys()) {
        if (accounted.has(sessionId)) continue;
        const fact = facts.get(sessionId);
        const bucket = slot('');
        if (fact.unread) bucket.unread += 1;
        if (fact.error) bucket.error += 1;
        if (fact.running) bucket.running += 1;
      }

      return { aggregates: next, unread, tasks: buildTasks(tasks, recent) };
    }

    function sortTasks(items) {
      return items.slice().sort((left, right) => {
        if (left.state === 'blocked' && right.state === 'blocked') return (left.since || 0) - (right.since || 0);
        if (left.state === 'running' && right.state === 'running') return (right.since || 0) - (left.since || 0);
        return (right.updatedAt || right.since || 0) - (left.updatedAt || left.since || 0);
      });
    }

    function buildTasks(tasks, recent) {
      const groups = [];
      const defs = [
        { key: 'blocked', states: ['blocked'] },
        { key: 'failed', states: ['failed'] },
        { key: 'running', states: ['running'] },
        { key: 'done', states: ['done'] },
      ];
      const counts = { blocked: 0, running: 0, failed: 0, done: 0 };
      for (const task of tasks) counts[task.state] += 1;
      for (const def of defs) {
        const items = sortTasks(tasks.filter((task) => def.states.includes(task.state)));
        if (items.length === 0) continue;
        groups.push({
          key: def.key,
          count: items.length,
          items: items.slice(0, PANEL_LIMIT),
          hidden: Math.max(0, items.length - PANEL_LIMIT),
        });
      }
      const historyItems = Array.isArray(recent) ? recent.slice(0, HISTORY_LIMIT) : [];
      if (prefs.history && historyItems.length > 0) {
        groups.push({ key: 'history', count: historyItems.length, items: historyItems, hidden: 0 });
      }
      return { counts, groups, total: tasks.length };
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
        result = buildSnapshot(ctx);
      } catch (error) {
        return;
      }
      aggregates = result.aggregates;
      badgeCount = result.unread;
      applyDockBadge(badgeCount);
      publishTasks(result.tasks);
      scheduleDots();
    }

    // ── 侧栏底部：任务面板 ──────────────────────────────────────────
    function useTasks() {
      const [snapshot, setSnapshot] = React.useState(taskSnapshot);
      React.useEffect(() => {
        setSnapshot(taskSnapshot);
        return subscribeTasks(() => setSnapshot(taskSnapshot));
      }, []);
      return snapshot;
    }

    function Icon(props) {
      const size = props && props.size ? props.size : 16;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': 'true', focusable: 'false',
      }, [
        h('rect', { key: 'l1', x: 2, y: 3.5, width: 9, height: 1.6, rx: 0.8, fill: 'currentColor', opacity: 0.75 }),
        h('rect', { key: 'l2', x: 2, y: 7.2, width: 7, height: 1.6, rx: 0.8, fill: 'currentColor', opacity: 0.55 }),
        h('rect', { key: 'l3', x: 2, y: 10.9, width: 5, height: 1.6, rx: 0.8, fill: 'currentColor', opacity: 0.35 }),
        h('circle', { key: 'd1', cx: 12.4, cy: 4.3, r: 2, fill: '#3b82f6' }),
        h('circle', { key: 'd2', cx: 12.4, cy: 11.7, r: 2, fill: '#22c55e' }),
      ]);
    }

    function relative(ms, t) {
      if (!ms) return '';
      const diff = Math.max(0, Date.now() - ms);
      const minute = 60000;
      if (diff < minute) return t('justNow');
      if (diff < 60 * minute) return t('minutes', { n: Math.round(diff / minute) });
      if (diff < 24 * 60 * minute) return t('hours', { n: Math.round(diff / (60 * minute)) });
      return t('days', { n: Math.round(diff / (24 * 60 * minute)) });
    }

    function taskMeta(task, t) {
      const parts = [];
      if (task.state === 'blocked') {
        if (task.kind === 'approval') parts.push(t('kindApproval'));
        else if (task.kind === 'plan-review') parts.push(t('kindPlan'));
        else if (task.kind === 'question') parts.push(t('kindQuestion'));
      }
      if (task.workspace) parts.push(task.workspace);
      return parts.join(' · ');
    }

    function TaskRow(props) {
      const task = props.task;
      const t = props.t;
      const time = relative(task.since || task.updatedAt, t);
      return h('button', {
        type: 'button',
        className: 'dshub_task',
        title: t('openAria', { name: task.title }),
        onClick: () => props.onOpen(task.id),
      }, [
        h('span', { key: 'dot', className: 'dshub_state', 'data-state': task.state }, null),
        h('span', { key: 'main', className: 'dshub_taskMain' }, [
          h('span', { key: 'title', className: 'dshub_taskTitle' }, task.title),
          taskMeta(task, t) === '' ? null : h('span', { key: 'meta', className: 'dshub_taskMeta' }, taskMeta(task, t)),
        ]),
        time === '' ? null : h('span', { key: 'time', className: 'dshub_taskTime' }, time),
      ]);
    }

    /** 历史里的一行：一个空心中性圆点 + 可以单独隐藏的 ×。 */
    function RecentRow(props) {
      const task = props.task;
      const t = props.t;
      const time = relative(task.since, t);
      return h('div', { className: 'dshub_recent' }, [
        h('button', {
          key: 'open',
          type: 'button',
          className: 'dshub_recentOpen',
          title: t('openAria', { name: task.title }),
          onClick: () => props.onOpen(task.id),
        }, [
          h('span', { key: 'clock', className: 'dshub_clock' }, null),
          h('span', { key: 'main', className: 'dshub_taskMain' }, [
            h('span', { key: 'title', className: 'dshub_taskTitle' }, task.title),
            task.workspace === '' ? null : h('span', { key: 'meta', className: 'dshub_taskMeta' }, task.workspace),
          ]),
          time === '' ? null : h('span', { key: 'time', className: 'dshub_taskTime' }, time),
        ]),
        h('button', {
          key: 'drop',
          type: 'button',
          className: 'dshub_recentDrop',
          title: t('dropHistory'),
          'aria-label': t('dropHistory'),
          onClick: (event) => {
            event.preventDefault();
            event.stopPropagation();
            props.onDrop(task.id);
          },
        }, '\u00d7'),
      ]);
    }

    /** 侧栏底部与悬浮球共用的列表本体。 */
    function TaskList(props) {
      const t = props.t;
      const tasks = props.tasks;
      const groups = tasks.groups;
      return [
        h('div', { key: 'head', className: 'dshub_panelHead' }, [
          h('span', { key: 'title', className: 'dshub_panelTitle' }, t('panelTitle')),
          props.compact ? h('span', { key: 'count', className: 'dshub_groupCount' }, String(props.needsYou)) : null,
        ]),
        groups.length === 0
          ? h('div', { key: 'empty', className: 'dshub_empty' }, t('empty'))
          : groups.map((group) => {
              const label = group.key === 'history'
                ? t('groupHistory')
                : t('group' + group.key.charAt(0).toUpperCase() + group.key.slice(1));
              return h('div', { key: group.key, className: 'dshub_group' }, [
                h('div', { key: 'head', className: 'dshub_groupHead' }, [
                  h('span', { key: 'label' }, label),
                  h('span', { key: 'n', className: 'dshub_groupCount' }, String(group.count)),
                  group.key === 'history'
                    ? h('button', {
                        key: 'clear',
                        type: 'button',
                        className: 'dshub_groupAction',
                        title: t('clearHint'),
                        onClick: () => props.onClearHistory(),
                      }, t('clearHistory'))
                    : null,
                ]),
                group.key === 'history'
                  ? group.items.map((task) => h(RecentRow, {
                      key: task.id, task: task, t: t, onOpen: props.onOpen, onDrop: props.onDropHistory,
                    }))
                  : group.items.map((task) => h(TaskRow, {
                      key: task.id, task: task, t: t, onOpen: props.onOpen,
                    })),
                group.hidden > 0 ? h('div', { key: 'more', className: 'dshub_more' }, t('more', { n: group.hidden })) : null,
              ]);
            }),
      ];
    }

    function dropHistory(sessionId) {
      forgetVisit(sessionId);
      refresh();
    }

    function TaskPanel(props) {
      const t = typeof props.t === 'function' ? props.t
        : typeof props.translate === 'function' ? props.translate
        : (key) => key;
      const wide = props.wide !== false;
      const tasks = useTasks();
      const [open, setOpen] = React.useState(false);
      const rootRef = React.useRef(null);
      const [anchor, setAnchor] = React.useState(undefined);

      // 弹层是 position:fixed（侧栏会裁 overflow），所以贴着自己量一次位置
      React.useLayoutEffect(() => {
        if (!open) return undefined;
        const place = () => {
          const element = rootRef.current;
          if (element === null) return;
          const rect = element.getBoundingClientRect();
          const width = Math.min(320, Math.max(240, window.innerWidth - 16));
          setAnchor({
            left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8)),
            bottom: Math.max(8, window.innerHeight - rect.top + 8),
          });
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
          window.removeEventListener('resize', place);
          window.removeEventListener('scroll', place, true);
        };
      }, [open]);

      React.useEffect(() => {
        if (!open) return undefined;
        const onPointer = (event) => {
          const element = rootRef.current;
          if (element !== null && event.target instanceof Node && element.contains(event.target)) return;
          setOpen(false);
        };
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onPointer, true);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('pointerdown', onPointer, true);
          document.removeEventListener('keydown', onKey);
        };
      }, [open]);

      if (!prefs.panel) return null;

      const counts = tasks.counts;
      const needsYou = counts.blocked + counts.failed + counts.done;
      const summary = wide
        ? [
            counts.running > 0 ? t('countRunning', { n: counts.running }) : '',
            counts.blocked > 0 ? t('countBlocked', { n: counts.blocked }) : '',
            counts.failed > 0 ? t('countFailed', { n: counts.failed }) : '',
            counts.done > 0 ? t('countDone', { n: counts.done }) : '',
          ].filter(Boolean).join(' · ')
        : needsYou > 0 ? String(needsYou) : '';

      const openSession = (sessionId) => {
        setOpen(false);
        try { props.openSession(sessionId); } catch (error) { /* 会话可能刚被删掉 */ }
      };

      return h('div', { className: wide ? 'dshub_foot' : 'dshub_foot dshub_footRail', ref: rootRef }, [
        open && anchor !== undefined ? h('section', {
          key: 'panel',
          className: 'dshub_panel',
          style: {
            left: anchor.left + 'px',
            bottom: anchor.bottom + 'px',
            width: Math.min(320, Math.max(240, window.innerWidth - 16)) + 'px',
          },
          role: 'dialog',
          'aria-label': t('panelAria'),
        }, TaskList({
          t: t,
          tasks: tasks,
          needsYou: needsYou,
          compact: !wide,
          onOpen: openSession,
          onDropHistory: dropHistory,
          onClearHistory: clearHistory,
        })) : null,
        h('button', {
          key: 'trigger',
          type: 'button',
          className: 'dshub_trigger',
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': t('panelAria'),
          title: wide ? '' : t('panelAria'),
          onClick: () => setOpen((value) => !value),
        }, [
          h('span', { key: 'icon', className: 'dshub_triggerIcon' }, h(Icon, { size: wide ? 16 : 18 })),
          h('span', { key: 'label', className: 'dshub_triggerLabel' }, t('panelTitle')),
          summary === '' ? null : h('span', { key: 'count', className: 'dshub_triggerCount' }, summary),
        ]),
      ]);
    }

    // ── ④ 侧栏收起后的悬浮球（shell.overlay） ──────────────────────
    const FLOAT_SIZE = 64;

    /** 侧栏是否展开：`data-sidebar-scrollport` 只在展开态挂在滚动区上。 */
    function sidebarPhase() {
      try {
        if (document.querySelector('[data-sidebar-scrollport]') !== null) return 'expanded';
        return 'collapsed';
      } catch (error) {
        return 'expanded';
      }
    }

    /** 收起后侧栏实际占的宽度：macOS 直接归零，Windows 会留 56px 图标条。 */
    function sidebarRailWidth() {
      try {
        const toggle = document.querySelector('[data-sidebar-toggle]');
        if (toggle === null) return 0;
        let node = toggle.parentElement;
        for (let depth = 0; depth < 8 && node !== null; depth += 1) {
          const rect = node.getBoundingClientRect();
          if (rect.height > (window.innerHeight || 0) * 0.5) {
            // 只认侧栏那根窄列；万一侧栏整个 display:none，往上会量到整帧，
            // 那时候按"没有竖条"处理，不能把悬浮球推到屏幕外。
            return rect.width > 0 && rect.width < 200 ? rect.width : 0;
          }
          node = node.parentElement;
        }
      } catch (error) { /* 量不到就按归零处理 */ }
      return 0;
    }

    function clampFloatTop(value) {
      const viewport = typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 800;
      // 下限 48：别让悬浮球拖到 macOS 红绿灯上。
      const max = Math.max(48, viewport - 8 - FLOAT_SIZE);
      const next = typeof value === 'number' && Number.isFinite(value) ? value : viewport / 2 - FLOAT_SIZE / 2;
      return Math.min(Math.max(48, next), max);
    }

    function FloatingTasks(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const tasks = useTasks();
      const [phase, setPhase] = React.useState(sidebarPhase);
      const [open, setOpen] = React.useState(false);
      const [top, setTop] = React.useState(() => {
        const saved = readFloatTop();
        return clampFloatTop(saved);
      });
      const rootRef = React.useRef(null);
      const dragRef = React.useRef(null);

      // 侧栏开合很频繁：轮询一个廉价的选择器就够了，比监听整棵 DOM 便宜。
      React.useEffect(() => {
        const update = () => {
          setPhase((current) => {
            const next = sidebarPhase();
            return next === current ? current : next;
          });
          setTop((value) => {
            const next = clampFloatTop(value);
            return next === value ? value : next;
          });
        };
        update();
        const timer = window.setInterval(update, 400);
        window.addEventListener('resize', update);
        return () => {
          window.clearInterval(timer);
          window.removeEventListener('resize', update);
        };
      }, []);

      React.useEffect(() => {
        if (phase === 'expanded') setOpen(false);
      }, [phase]);

      React.useEffect(() => {
        if (!open) return undefined;
        const onPointer = (event) => {
          const element = rootRef.current;
          if (element !== null && event.target instanceof Node && element.contains(event.target)) return;
          setOpen(false);
        };
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onPointer, true);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('pointerdown', onPointer, true);
          document.removeEventListener('keydown', onKey);
        };
      }, [open]);

      if (!prefs.float || phase === 'expanded') return null;

      const counts = tasks.counts;
      const needsYou = counts.blocked + counts.failed + counts.done;
      const tone = counts.failed > 0 ? 'error'
        : counts.blocked > 0 ? 'blocked'
        : counts.done > 0 ? 'done'
        : counts.running > 0 ? 'running'
        : '';
      const left = Math.max(8, sidebarRailWidth() + 8);
      const panelWidth = Math.min(320, Math.max(240, window.innerWidth - left - 48));
      const panelHeight = Math.min(window.innerHeight * 0.6, 520);
      // 面板也从 48 起步，避开窗口左上角的红绿灯与标题条。
      const panelTop = Math.max(48, Math.min(top + FLOAT_SIZE / 2 - panelHeight / 2, window.innerHeight - 8 - panelHeight));
      const summary = [
        counts.running > 0 ? t('countRunning', { n: counts.running }) : '',
        counts.blocked > 0 ? t('countBlocked', { n: counts.blocked }) : '',
        counts.failed > 0 ? t('countFailed', { n: counts.failed }) : '',
        counts.done > 0 ? t('countDone', { n: counts.done }) : '',
      ].filter(Boolean).join(' · ');

      const openSession = (sessionId) => {
        setOpen(false);
        try { props.openSession(sessionId); } catch (error) { /* 会话可能刚被删掉 */ }
      };

      const endDrag = (event, allowOpen) => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (drag === null) return;
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch (error) { /* ignore */ }
        if (drag.moved) {
          const next = clampFloatTop(drag.top + (event.clientY - drag.y));
          setTop(next);
          writeFloatTop(next);
          return;
        }
        if (allowOpen) setOpen((value) => !value);
      };

      return h('div', {
        className: 'dshub_float',
        ref: rootRef,
        style: { left: left + 'px', top: top + 'px' },
      }, [
        open ? h('section', {
          key: 'panel',
          className: 'dshub_panel',
          style: { left: (left + 38) + 'px', top: panelTop + 'px', width: panelWidth + 'px' },
          role: 'dialog',
          'aria-label': t('panelAria'),
        }, TaskList({
          t: t,
          tasks: tasks,
          needsYou: needsYou,
          compact: false,
          onOpen: openSession,
          onDropHistory: dropHistory,
          onClearHistory: clearHistory,
        })) : null,
        h('button', {
          key: 'handle',
          type: 'button',
          className: 'dshub_floatBtn',
          'data-tone': tone === '' ? undefined : tone,
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': t('panelAria'),
          title: summary === '' ? t('panelTitle') : t('panelTitle') + ' · ' + summary,
          onPointerDown: (event) => {
            if (typeof event.button === 'number' && event.button !== 0) return;
            dragRef.current = { y: event.clientY, top: top, moved: false };
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
          },
          onPointerMove: (event) => {
            const drag = dragRef.current;
            if (drag === null) return;
            const dy = event.clientY - drag.y;
            if (!drag.moved && Math.abs(dy) > 4) drag.moved = true;
            if (!drag.moved) return;
            if (typeof event.preventDefault === 'function') event.preventDefault();
            setTop(clampFloatTop(drag.top + dy));
          },
          onPointerUp: (event) => endDrag(event, true),
          onPointerCancel: (event) => endDrag(event, false),
          onClick: (event) => { if (event.detail === 0) setOpen((value) => !value); },
        }, [
          h('span', { key: 'icon', className: 'dshub_floatIcon' }, h(Icon, { size: 16 })),
          needsYou === 0 ? null : h('span', { key: 'count', className: 'dshub_floatCount' }, String(needsYou)),
        ]),
      ]);
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
        line('panel', 'panel', 'panelHint'),
        line('float', 'float', 'floatHint'),
        line('dock', 'dock', 'dockHint'),
        line('dots', 'dots', 'dotsHint'),
        line('history', 'history', 'historyHint'),
        line('running', 'running', 'runningHint'),
        h('div', { className: 'dshub_legend', key: 'legend' }, [
          swatch('#f59e0b', 'groupBlocked'),
          swatch('#ef4444', 'legendError'),
          swatch('#3b82f6', 'legendRunning'),
          swatch('#22c55e', 'legendUnread'),
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

      // 侧栏底部：任务面板。和「自动化任务」同一个席位，常驻在设置上方。
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'unreadBadge',
        order: 10,
        locale: NS,
        inject: () => ({
          openSession: (sessionId) => {
            try { ctx.uiWorkspace.openSession(sessionId); } catch (error) { /* 会话可能已经不在了 */ }
          },
        }),
      }, TaskPanel));

      // 侧栏收起后的悬浮球：注册进 frames 的 `shell.overlay` 浮层，
      // 不吃侧栏的 overflow，侧栏完全藏起来时也还在。
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'unreadBadge.float',
        order: 40,
        locale: NS,
        inject: () => ({
          openSession: (sessionId) => {
            try { ctx.uiWorkspace.openSession(sessionId); } catch (error) { /* 会话可能已经不在了 */ }
          },
        }),
      }, FloatingTasks));

      // 调试口，和 notify-me 的 __dshNotifyMe 一个路数
      window.__dshUnreadBadge = {
        state: () => ({
          badgeCount,
          badgeSupported,
          dock: prefs.dock,
          dots: prefs.dots,
          running: prefs.running,
          panel: prefs.panel,
          float: prefs.float,
          history: prefs.history,
          recent: history.map((entry) => ({ id: entry.id, at: entry.at })),
          current: lastCurrentId,
          errors: Array.from(errors.keys()),
          workspaces: Array.from(aggregates.entries()).map(([key, value]) => ({ key, ...value })),
        }),
        tasks: () => JSON.parse(JSON.stringify(taskSnapshot)),
        refresh: () => refresh(),
        prefs: () => Object.assign({}, prefs),
        forget: (sessionId) => dropHistory(sessionId),
        clearHistory: () => clearHistory(),
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
