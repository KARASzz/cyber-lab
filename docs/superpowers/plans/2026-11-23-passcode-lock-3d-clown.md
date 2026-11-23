# 前端九宫格安全密码锁与小丑 3D 翻转动效实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 CYBER//LAB 首页构建入口级强阻断密码门禁，输错触发 3D 顺时针翻转至纯图小丑，点击小丑继续顺时针回旋 180° 复原，解锁后支持一键锁定。

**Architecture:** 
- HTML: 在 `index.html` 插入 `#lab-lock-screen` 遮罩层，内含带 3D preserve-3d 的卡片，正面为 4 位圆点掩码指示器与 3×4 九宫格键盘，背面为纯图无字的 1:1 马戏团小丑矢量插画。主站顶栏增加锁定按钮。
- CSS: `perspective: 1200px`，`transform-style: preserve-3d`，`backface-visibility: hidden`。翻转使用 `cubic-bezier(0.4, 0, 0.2, 1)` 0.75s。
- JS: 门禁状态机。默认未解锁时 `#lab-app` 处于 `inert` 状态，阻止网络初始化。输入满 4 位比对 `2580`：成功写入 `sessionStorage` 并解锁；失败顺时针旋转至 180°；点击背面小丑顺时针旋转至 360°，动画结束后重置为 0° 并清空输入。点击顶栏锁定立即销毁认证态。

**Tech Stack:** Vanilla JS (ES Modules), CSS3 3D Transforms, SVG Graphics, Playwright.

---

### Task 1: 编写 HTML 门禁骨架与纯图小丑插画

**Files:**
- Modify: `index.html`

- [ ] **Step 1: 添加锁定遮罩与 3D 翻转卡片结构**
在 `index.html` `<body>` 顶部插入 `#lab-lock-screen`，包含 `lab-flipper`、正面 `lab-card-front`（指示器 + 九宫格）与背面 `lab-card-back`（纯小丑 SVG 插画）。

- [ ] **Step 2: 顶栏添加锁定工作台按钮**
在 `#lab-topbar` 的 `.topbar-right` 中添加 `#lab-lock-btn`。

- [ ] **Step 3: 语法校验**
运行：`node scripts/build-static.mjs`

---

### Task 2: 编写 CSS 3D 透视、翻转动画与小丑视觉样式

**Files:**
- Modify: `styles/lab.css`

- [ ] **Step 1: 编写 3D 透视与卡片正反面样式**
包含 `perspective: 1200px`、`transform-style: preserve-3d`、`backface-visibility: hidden`。

- [ ] **Step 2: 编写翻转状态类与小丑悬停样式**
`.is-flipped` 旋转至 180deg，`.is-returning` 旋转至 360deg；小丑热区 `cursor: pointer` 并微放大 `scale(1.025)`。

- [ ] **Step 3: 空白与格式检查**
运行：`git diff --check`

---

### Task 3: 编写门禁交互逻辑与安全阻断状态机

**Files:**
- Modify: `app.js`

- [ ] **Step 1: 编写门禁控制器**
支持数字键输入、退格、清空、掩码指示器更新。

- [ ] **Step 2: 实现 0° -> 180° -> 360° 顺时针同向翻转与归零**
比对 `2580`：输错增加 `.is-flipped`；点击小丑移除 `.is-flipped` 增加 `.is-returning`，监听 `transitionend` 移除类并清空输入。

- [ ] **Step 3: 实现 Fail-Closed 阻断与锁定退出**
未解锁时阻断 `initCloudWorkspace`，解锁后启动；点击 `#lab-lock-btn` 重新激活门禁。

---

### Task 4: 测试覆盖与回归验证

**Files:**
- Create: `tests/e2e/lockscreen.spec.ts`
- Modify: `playwright.config.ts` (确保已有测试在预置认证态下无缝执行)

- [ ] **Step 1: 编写门禁与翻转测试**
- [ ] **Step 2: 运行全量测试**
运行：`npm run check && npm run test:e2e`

---

### Task 5: 部署与提交推送

- [ ] **Step 1: 重新构建静态文件**
- [ ] **Step 2: 提交并推送到 GitHub 远程仓库**
