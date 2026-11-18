# dsh-unread-badge

[![npm](https://img.shields.io/npm/v/@fanfan4589/dsh-unread-badge)](https://www.npmjs.com/package/@fanfan4589/dsh-unread-badge) [![license](https://img.shields.io/npm/l/@fanfan4589/dsh-unread-badge)](./LICENSE)

[English](./README.md) · 中文


给 DeepSeek Harness 补上「未读」和「任务在哪」这两件事：**Dock 图标上的数字角标** + **侧栏底部的任务总览**（几个在跑、几个卡住、几个完成，点开看明细并直达会话）+ **工作区标题行上的彩色点** + **侧栏收起后的悬浮球**（不用展开侧栏就能点回任务）+ **最近待过的 3 个会话**（历史，手动可隐藏）。

> 纯渲染层方案：不需要 Host 路由、不落盘、不新增数据源，所有事实都来自宿主自己的 `sessionStatus` / `sessions.list` / `workspaces.list`。

> **定位｜克制的小功能补丁。** 只做这几件事，不改 DSH 主体：只占用官方预留的扩展席位（`sidebar.footer.action`、`settings.general.item`），不替换布局、不改内核行为、不碰其他插件的数据。升级 DSH 一般无需跟着改；关掉或卸载即回到官方状态。

## 它做什么

| 需求 | 实现 |
| --- | --- |
| 图标上的红色数字 = 未读任务数 | `navigator.setAppBadge(n)`：完成的回复没打开过、或这一轮出错，各算一个未读；全部打开后清空 |
| 侧栏底部的任务总览 | `sidebar.footer.action` 席位常驻一行：`2 进行 · 1 卡住 · 3 完成`；点开按「卡住 / 失败 / 进行中 / 完成」分组列出会话，点任一行直达对应会话 |
| 侧栏收起后的悬浮球 | `shell.overlay` 席位上的一个左边缘小把手（只在侧栏收起时出现）：点开就是同一个任务面板，可以上下拖，位置记在本地 |
| 最近待过的 3 个会话 | 自动记下你最近真正打开过的 3 个会话（不管是从侧栏、从历史、还是从别处跳进去的），存在 `localStorage`，刷新不丢；每条可单独隐藏，也能一键清空 |
| 折叠工作区上的提醒点 | 每个 `data-row-key="workspace:<id>"` 标题行右侧插一个 7px 圆点，按组内状态取色 |
| 声音提醒 | 不重复造：与 `dsh-notify-me` / `dsh-plugin-notify-sounds` 共存，本插件**不出声**，避免双响 |

颜色优先级（同一行只显示优先级最高的一个点）：

| 颜色 | 含义 |
| --- | --- |
| 🔴 红 | 组内有会话**出错**（`api-session/error`） |
| 🟢 绿 | 组内有**完成但没打开**的回复 |
| 🔵 蓝（呼吸） | 组内有会话**正在运行**（可在设置里关掉） |

「已经看过」沿用宿主的判定：会话在主页显示（`retainedBy.mainView > 0`）或宿主清掉 `completionUnread`。失败没有原生未读位，插件自己记，打开该会话即清；同一会话开始新一轮运行也会清掉上一次的失败标记。

子代理（subagent）会话默认不计入——它们是主对话那一轮的步骤，不是你要做的事；归档会话同样不计入。

## 侧栏任务总览

侧栏最底部（设置上方）常驻一行，和 DSH 自己的「自动化任务」占同一个席位：

```
● 任务                              2 进行 · 1 卡住 · 3 完成
```

点开后向上弹出一个 320px 的浮层，四组按优先级排列：

```
任务
  卡住 1
    ◐ 修复登录态过期        等你审批 · dsh-unread-badge   3 分钟
  进行中 2
    ● 重构插件面板           dsh-unread-badge            12 分钟
    ● 校对逐字稿             文案项目                     4 分钟
  完成 3
    ✓ 生成周报               日常                         8 分钟
  历史                                         清空
    ○ 看完的周报             日常                         刚刚
```

| 分组 | 判定 | 颜色 |
| --- | --- | --- |
| **卡住** | `pendingInteraction`：审批 / 计划确认 / 提问，全算卡住 | 琥珀 |
| **失败** | 这一轮出错（`api-session/error`），打开会话即清 | 红 |
| **进行中** | 正在跑，且没有在等你 | 蓝（呼吸） |
| **完成** | 跑完但**还没打开过**（`completionUnread`），打开即消 | 绿 |
| **历史** | 最近真正待过的 3 个会话；只显示当前不在这四组里的，避免重复 | 中性空心圈 |

- 点任一行 → `uiWorkspace.openSession(id)` 进对应会话，浮层自动关闭；点外面或按 `Esc` 也关。
- 每行显示：状态点、会话标题（超长省略）、卡住原因与工作区名、相对时间（跑了/等了多久）。
- **历史**：鼠标移到某一条上会出现 `×`，点它只隐藏这一条；分组标题右侧的「清空」一次清掉全部。清空后不会立刻把当前会话又写回来，等你切到别的会话才重新开始记。
- 侧栏收成 56px 图标条时只剩图标和「需要你的条数」（卡住 + 失败 + 完成）。
- 每组最多列 30 条，多的显示「还有 N 条」。

## 侧栏收起后：悬浮球

侧栏一收起来，任务行就跟着没了，只能先把侧栏展开才能点任务。悬浮球补的就是这一段：

- 注册在 `shell.overlay`（横跨整个窗口、在每一列之上的那层浮层），所以**不受侧栏宽度和 `overflow` 影响**，侧栏完全藏起来时它还在；
- 只在侧栏收起时出现，侧栏展开后自动让位给底部那行，不会重复；
- 停在窗口左边缘、垂直居中，**可以上下拖**，松手即记住位置（`dsh-unread-badge:float-top`）；
- 按钮上显示「需要你」的条数（卡住 + 失败 + 完成），左侧色条按最高优先级取色；
- 点一下展开的仍是同一个任务面板（含历史），点任一行直达会话；
- 侧栏是 Windows 那种 56px 图标条时，它会自动让开竖条，停在竖条右侧。

## 历史：最近待过的 3 个会话

「点开一个完成的会话 → 看了一眼 → 去忙别的 → 回来忘了刚才在哪」这条路径，用历史兜住：

- 判定不靠「点了哪一行」，而是看宿主的 `retainedBy.mainView > 0`（当前主视图显示的那个会话）。所以在哪进的都算：侧栏点进来的、从历史点回去的、新建的；
- **只留 3 条**，按最近一次待过的时间排序；会话被删掉或归档时，对应历史自动清掉；
- 已经在「卡住 / 失败 / 进行中 / 完成」里出现的会话不会在历史里重复列一遍；
- 存在 `localStorage`（`dsh-unread-badge:history`），刷新、重启都不丢；
- 每条可单独隐藏（悬停出现 `×`），也可「清空」；设置里还能整组关掉。

## 数据从哪来

```
uiSession.sessionStatus      Map<sessionId, {running, pendingInteraction, completionUnread}>
sessions.list                { ids, byId }  → retainedBy.mainView / origin / running
uiWorkspace.workspaces.list  { items: [{ workspaceId, sessionIds }] }  → 会话挂在哪个工作区
remote.$on('api-session/error')  (sessionId, message)                  → 失败
retainedBy.mainView > 0      → 当前主视图显示的那个会话，历史就靠它判定
data-sidebar-scrollport / data-sidebar-toggle  → 侧栏展开还是收起（悬浮球用）
```

侧栏没有「工作区标题行」的插槽（`sidebar.*` 里只有会话行那一组），所以圆点是 **DOM 补丁**：靠 `data-row-key` 和 `row.lastElementChild` 定位，插在 hover 动作按钮之前。DSH 改这两个结构时点会消失，但不会报错、不影响任何原生功能。

## 安装

DSH 桌面版 → 左侧栏 **插件** → 添加插件 → 填目录绝对路径：

```
/Users/feifan/FEIFAN/08-系统/08DSH插件/dsh-unread-badge
```

装完 **⌘R** 刷新窗口。

## 设置

**设置 → 通用 → 未读提醒**：

- **侧栏任务总览**：底部那一行的总开关；
- **侧栏收起时的悬浮球**：左边缘悬浮把手的总开关；
- **Dock 数字角标**：总开关；
- **工作区提醒点**：总开关；
- **历史（最近 3 个会话）**：历史分组的开关；关掉后不再记录，已有记录保留；
- **也在运行的会话上显示蓝点**：关掉后只提示未读与出错。

偏好存在 `localStorage` 的 `dsh-unread-badge:prefs`。

## 自检

DevTools（⌘⌥I）控制台：

```js
__dshUnreadBadge.state()
// { badgeCount, badgeSupported, dock, dots, running, panel, float, history, recent, current, errors, workspaces }
__dshUnreadBadge.tasks()     // 面板正在用的快照：{ counts, groups, total }
__dshUnreadBadge.refresh()   // 立刻重算一次
__dshUnreadBadge.state().recent   // 历史里的 [{ id, at }]，最前面是最近待过的
__dshUnreadBadge.forget('id')     // 手动隐藏一条历史
__dshUnreadBadge.clearHistory()   // 清空历史
```

- `badgeSupported: false` 表示当前渲染层没有 `navigator.setAppBadge`（例如网页版没安装成 PWA）——角标不可用，圆点照常。
- `workspaces` 里能看到每个工作区当前的 `{unread, error, running}` 计数。

## 已知边界

- **Dock 角标只在桌面版可用**：Web 版要走 Chrome 把 DSH 安装成 PWA 才有归属，浏览器标签页不显示。
- **不处理系统通知权限**：角标不走通知通道，不需要授权。
- **圆点是 DOM 补丁**：DSH 大版本改侧栏结构时可能需要跟着改选择器（`data-row-key` 前缀 / 行尾动作按钮）。
- 侧栏收成 56px 图标条时工作区标题行本身不渲染，圆点也自然跟着隐藏。
- **任务浮层是手算锚点**：侧栏会裁 `overflow`，所以浮层用 `position: fixed` 贴着触发行往上弹，窗口缩放/滚动时重新量一次。极窄窗口下会贴边并收窄到 240px。
- **悬浮球靠 DOM 记号判断侧栏形态**：`[data-sidebar-scrollport]`（展开）与 `[data-sidebar-toggle]` 量出的竖条宽度。DSH 改侧栏结构时这里要跟着改选择器；判不出来时会当作展开态，悬浮球不出现，其余功能不受影响。
- **历史是本地记录**：存在 `localStorage`，换浏览器/清缓存会丢；只记会话 id 与「最后待过的时间」，标题永远从宿主实况取。
- **相对时间每分钟刷新一次**；会话标题取 `title` → `displayTitle` → 目录名 → 会话 id。

## 来源与致谢

本插件是独立实现：`client.js` 里没有从其它插件复制来的代码。设计上参考了生态里两件同方向的作品，都读过它们的源码来确认宿主 API 的用法：

- **dsh-plugin-desktop-notify**（MIT，© chendaleiQ）：Dock 角标走渲染层 `navigator.setAppBadge()` 这条路、以及「未读 = 完成未读 + 失败」的事实模型，是从它这里学到并验证的。
- **dsh-notify-me**（MIT，© chromoany）：如何安全地从 `uiSession.sessionStatus` / `sessions.list` 读宿主状态、`inject` 的写法，参考了它的实现。

两者都是 MIT，即便有片段级借鉴也允许使用与再分发；这里按开源习惯在致谢里点名。本插件本身以 **MIT** 发布，见 [`LICENSE`](./LICENSE)。

## 开发

```sh
node --check client.js
node test/smoke.mjs      # 离线冒烟：宿主桩 + 聚合 + 插点 + 角标 + 出错回落 + 任务快照（卡住/进行/完成/历史分组 + 隐藏历史）
```

`client.js` 是浏览器可直接加载的模块（`window.__ModuleLoader__.load`），改完刷新页面即生效，没有构建步骤。`index.js` 只是让 bundle 行可解析的空 Host 半边。
