# dsh-unread-badge

给 DeepSeek Harness 补上「未读」这件事：**Dock 图标上的数字角标** + **工作区标题行上的彩色点**。折叠起来的工作区也能一眼看出里面有没有跑完没看的结果。

> 纯渲染层方案：不需要 Host 路由、不落盘、不新增数据源，所有事实都来自宿主自己的 `sessionStatus` / `sessions.list` / `workspaces.list`。

> **定位｜克制的小功能补丁。** 只做这一件事，不改 DSH 主体：不替换内置槽位与布局、不改内核行为、不碰其他插件的数据。升级 DSH 一般无需跟着改；关掉或卸载即回到官方状态。

## 它做什么

| 需求 | 实现 |
| --- | --- |
| 图标上的红色数字 = 未读任务数 | `navigator.setAppBadge(n)`：完成的回复没打开过、或这一轮出错，各算一个未读；全部打开后清空 |
| 折叠工作区上的提醒点 | 每个 `data-row-key="workspace:<id>"` 标题行右侧插一个 7px 圆点，按组内状态取色 |
| 声音提醒 | 不重复造：与 `dsh-notify-me` / `dsh-plugin-notify-sounds` 共存，本插件**不出声**，避免双响 |

颜色优先级（同一行只显示优先级最高的一个点）：

| 颜色 | 含义 |
| --- | --- |
| 🔴 红 | 组内有会话**出错**（`api-session/error`） |
| 🟢 绿 | 组内有**完成但没打开**的回复 |
| 🔵 蓝（呼吸） | 组内有会话**正在运行**（可在设置里关掉） |

「已经看过」沿用宿主的判定：会话在主页显示（`retainedBy.mainView > 0`）或宿主清掉 `completionUnread`。失败没有原生未读位，插件自己记，打开该会话即清；同一会话开始新一轮运行也会清掉上一次的失败标记。

子代理（subagent）会话默认不计入——它们是主对话那一轮的步骤，不是你要做的事。

## 数据从哪来

```
uiSession.sessionStatus      Map<sessionId, {running, pendingInteraction, completionUnread}>
sessions.list                { ids, byId }  → retainedBy.mainView / origin / running
uiWorkspace.workspaces.list  { items: [{ workspaceId, sessionIds }] }  → 会话挂在哪个工作区
remote.$on('api-session/error')  (sessionId, message)                  → 失败
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

- **Dock 数字角标**：总开关；
- **工作区提醒点**：总开关；
- **也在运行的会话上显示蓝点**：关掉后只提示未读与出错。

偏好存在 `localStorage` 的 `dsh-unread-badge:prefs`。

## 自检

DevTools（⌘⌥I）控制台：

```js
__dshUnreadBadge.state()
// { badgeCount, badgeSupported, dock, dots, running, errors, workspaces }
__dshUnreadBadge.refresh()   // 立刻重算一次
```

- `badgeSupported: false` 表示当前渲染层没有 `navigator.setAppBadge`（例如网页版没安装成 PWA）——角标不可用，圆点照常。
- `workspaces` 里能看到每个工作区当前的 `{unread, error, running}` 计数。

## 已知边界

- **Dock 角标只在桌面版可用**：Web 版要走 Chrome 把 DSH 安装成 PWA 才有归属，浏览器标签页不显示。
- **不处理系统通知权限**：角标不走通知通道，不需要授权。
- **圆点是 DOM 补丁**：DSH 大版本改侧栏结构时可能需要跟着改选择器（`data-row-key` 前缀 / 行尾动作按钮）。
- 侧栏收成 56px 图标条时工作区标题行本身不渲染，圆点也自然跟着隐藏。

## 来源与致谢

本插件是独立实现：`client.js` 里没有从其它插件复制来的代码。设计上参考了生态里两件同方向的作品，都读过它们的源码来确认宿主 API 的用法：

- **dsh-plugin-desktop-notify**（MIT，© chendaleiQ）：Dock 角标走渲染层 `navigator.setAppBadge()` 这条路、以及「未读 = 完成未读 + 失败」的事实模型，是从它这里学到并验证的。
- **dsh-notify-me**（MIT，© chromoany）：如何安全地从 `uiSession.sessionStatus` / `sessions.list` 读宿主状态、`inject` 的写法，参考了它的实现。

两者都是 MIT，即便有片段级借鉴也允许使用与再分发；这里按开源习惯在致谢里点名。本插件本身以 **MIT** 发布，见 [`LICENSE`](./LICENSE)。

## 开发

```sh
node --check client.js
node test/smoke.mjs      # 离线冒烟：宿主桩 + 聚合 + 插点 + 角标 + 出错回落
```

`client.js` 是浏览器可直接加载的模块（`window.__ModuleLoader__.load`），改完刷新页面即生效，没有构建步骤。`index.js` 只是让 bundle 行可解析的空 Host 半边。
