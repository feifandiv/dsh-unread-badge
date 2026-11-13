/**
 * 离线冒烟：不启动 DSH，用桩模拟宿主，跑一遍 client.js 的 apply。
 * 用法：node test/smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

// ── 最小 DOM ──────────────────────────────────────────────────────
function element(tag) {
  return {
    tagName: tag,
    children: [],
    attrs: new Map(),
    style: {},
    parentNode: null,
    setAttribute(name, value) { this.attrs.set(name, String(value)); },
    getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; },
    hasAttribute(name) { return this.attrs.has(name); },
    removeAttribute(name) { this.attrs.delete(name); },
    appendChild(node) { node.parentNode = this; this.children.push(node); return node; },
    insertBefore(node, before) {
      const index = this.children.indexOf(before);
      node.parentNode = this;
      if (index < 0) this.children.push(node);
      else this.children.splice(index, 0, node);
      return node;
    },
    remove() {
      if (this.parentNode === null) return;
      const list = this.parentNode.children;
      const index = list.indexOf(this);
      if (index >= 0) list.splice(index, 1);
      this.parentNode = null;
    },
    get lastElementChild() { return this.children.length > 0 ? this.children[this.children.length - 1] : null; },
  };
}

const rows = [];
const document = {
  documentElement: element('html'),
  head: element('head'),
  body: element('body'),
  createElement: element,
  querySelectorAll(selector) {
    if (selector === '[data-row-key^="workspace:"]') return rows;
    if (selector === '[data-dsh-unread-dot]') return rows.flatMap((row) => row.children.filter((c) => c.hasAttribute('data-dsh-unread-dot')));
    return [];
  },
};

const badges = [];
const navigator = {
  setAppBadge(value) { badges.push(['set', value]); },
  clearAppBadge() { badges.push(['clear']); },
};

const storage = new Map();
const rafQueue = [];
/** 浏览器里 rAF 是下一帧才跑；测试里手动把队列放掉，行为才和真实一致。 */
function flushRaf() {
  const queue = rafQueue.splice(0, rafQueue.length);
  for (const fn of queue) fn();
}
const window = {
  __ModuleLoader__: { load(def) { loaded = def; } },
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, v),
  },
    requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length; },
  setInterval() { return 1; },
  clearInterval() {},
  addEventListener() {},
  removeEventListener() {},
  Notification: { permission: 'granted' },
};

let loaded = null;
const sandbox = {
  window, document, navigator, console,
  MutationObserver: class { observe() {} disconnect() {} },
  requestAnimationFrame: window.requestAnimationFrame,
  setInterval: window.setInterval,
  clearInterval: window.clearInterval,
  localStorage: window.localStorage,
  Math, Date, Map, Set, Array, Object, JSON, String, Number, Boolean, Error, Promise,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'client.js' });

const React = { createElement: (type, props, ...children) => ({ type, props, children }) };
const mod = loaded.factory((name) => (name === 'react' ? React : {}));

// ── 宿主桩 ────────────────────────────────────────────────────────
function store(initial) {
  let snapshot = initial;
  const subs = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    update(next) { snapshot = next; for (const fn of subs) fn(); },
  };
}

const status = store(new Map());
const list = store({
  phase: 'ready',
  ids: ['s1', 's2', 's3'],
  byId: {
    s1: { id: 's1', title: '完成未读', running: false, retainedBy: { mainView: 0 } },
    s2: { id: 's2', title: '出错', running: false, retainedBy: { mainView: 0 } },
    s3: { id: 's3', title: '在跑', running: true, retainedBy: { mainView: 1 } },
  },
});
const workspaces = store({
  phase: 'ready',
  items: [
    { workspaceId: 'ws-a', title: 'A', sessionIds: ['s1'] },
    { workspaceId: 'ws-b', title: 'B', sessionIds: ['s2', 's3'] },
  ],
});

status.update(new Map([
  ['s1', { running: false, completionUnread: true }],
  ['s2', { running: false, completionUnread: false }],
  ['s3', { running: true, completionUnread: false }],
]));

// 两行工作区 + 一行动作按钮，模拟真实 DOM 结构
for (const key of ['ws-a', 'ws-b']) {
  const row = element('div');
  row.setAttribute('data-row-key', 'workspace:' + key);
  row.appendChild(element('span'));      // folder icon
  row.appendChild(element('span'));      // chevron
  row.appendChild(element('span'));      // projectText
  row.appendChild(element('span'));      // rowActions
  rows.push(row);
}

let errorHandler = null;
const ctx = {
  sessions: { list },
  uiSession: { sessionStatus: status },
  uiWorkspace: { workspaces: { list: workspaces } },
  locale: { register: () => () => {}, bind: () => (key) => key },
  slots: { inject: (name, fn) => fn(), register: () => () => {} },
  get: (name) => (name === 'remote' ? { $on: (event, handler) => { if (event === 'api-session/error') errorHandler = handler; return () => {}; } } : undefined),
  effect(fn) { const dispose = fn(); return dispose; },
};

mod.apply(ctx);
flushRaf();

function assert(condition, message) {
  if (!condition) { console.error('✗ ' + message); process.exitCode = 1; }
  else console.log('✓ ' + message);
}

const dotA = rows[0].children.find((c) => c.hasAttribute('data-dsh-unread-dot'));
const dotB = rows[1].children.find((c) => c.hasAttribute('data-dsh-unread-dot'));

assert(mod.inject.join(',') === 'sessions,uiSession,uiWorkspace,locale,slots', 'inject 列表');
assert(dotA !== undefined, 'ws-a 行插入了点');
assert(dotA.getAttribute('data-tone') === 'unread', 'ws-a 是绿色未读点');
assert(dotB !== undefined && dotB.getAttribute('data-tone') === 'running', 'ws-b 是没有未读时的蓝色运行点');
assert(badges.length === 1 && badges[0][0] === 'set' && badges[0][1] === 1, 'Dock 角标 = 1（只有 s1 未读）');

// 一次失败：s2 出错 → 红色 + 角标 2
errorHandler('s2', '模型调用失败');
flushRaf();
const dotB2 = rows[1].children.find((c) => c.hasAttribute('data-dsh-unread-dot'));
assert(dotB2.getAttribute('data-tone') === 'error', 's2 出错后 ws-b 变红');
assert(badges.at(-1)[0] === 'set' && badges.at(-1)[1] === 2, '出错计入角标 → 2');

// 打开 s1（retainedBy.mainView 变 1）+ 宿主清掉未读 → 角标回落
list.update({
  phase: 'ready',
  ids: ['s1', 's2', 's3'],
  byId: {
    s1: { id: 's1', title: '完成未读', running: false, retainedBy: { mainView: 1 } },
    s2: { id: 's2', title: '出错', running: false, retainedBy: { mainView: 1 } },
    s3: { id: 's3', title: '在跑', running: true, retainedBy: { mainView: 1 } },
  },
});
status.update(new Map([
  ['s1', { running: false, completionUnread: false }],
  ['s2', { running: false, completionUnread: false }],
  ['s3', { running: true, completionUnread: false }],
]));
flushRaf();
assert(badges.at(-1)[0] === 'clear', '全部读掉后角标清空');

const state = window.__dshUnreadBadge.state();
assert(state.badgeCount === 0 && state.errors.length === 0, '调试口状态同步');

console.log('\nstate =', JSON.stringify(state));
