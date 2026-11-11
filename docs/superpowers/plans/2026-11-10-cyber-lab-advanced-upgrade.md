# CYBER//LAB 高级升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 本仓库默认由主线程内联执行；只有用户明确要求委派时才使用子智能体。本计划尚未获得实施批准。

**Goal:** 将现有 NEON//CHAT 从“霓虹聊天页”升级为以实验记录、可复现上下文、真实运行状态和数据自主权为核心的 CYBER//LAB 极客实验室，同时保持现有聊天能力与本地数据向后兼容。

**Architecture:** 保留静态 HTML/CSS/原生 JavaScript、Cloud Function 薄代理与 Agent 双路径，不引入前端框架、账号体系或服务端数据库。先把可测试核心从 `app.js` 拆为原生 ES modules，再重构工作台界面，随后增加实验笔记、搜索、命令面板和安全导入导出，最后以响应头和客户端计时补齐真实遥测；SSE 的 delta/error/DONE 契约保持不变。

**Tech Stack:** HTML、CSS、原生 JavaScript ES modules、Node.js 20+、EdgeOne Makers、`tsx` + `node:test`、Playwright、axe-core；运行时依赖继续为零。

---

## 1. 现状与升级判断

### 1.1 已核实的现状

- `index.html` 254 行、`style.css` 1088 行、`app.js` 1818 行；前端无框架、无构建、无 CDN。
- 已有项目/会话 CRUD、项目级系统指令、4 个预设、Markdown、代码复制、SSE 分块解析、停止/重试、世代隔离、localStorage 异常降级。
- 对话存储键为 `cyberchat.v1`，最多 50 项目、每项目 100 会话、每会话 200 条消息。
- 后端有 `/api/chat` → `/chat` 的 Agent 主路径和函数直连 AI Gateway 的降级路径；两条路径各自维护一套校验和提示词组装。
- 当前首页显示“神经链路 · 已连接”，但它实际上主要反映本地流式状态，不能证明网络、Agent 或网关健康。
- 当前侧栏展示 `+N`，源码没有对应快捷键；新版不允许保留未实现的快捷键提示。
- 历史文档记录过大量自测，但仓库没有可运行的测试文件；`npm run build` 只是输出提示，不是构建验证，更不是功能测试。
- `main` 已配置生产自动部署。实施必须先在功能分支和 preview 验收，不能把“推送成功”或“构建成功”当作聊天可用。

### 1.2 设计路线选择

| 路线 | 结果 | 决策 |
|---|---|---|
| 只换霓虹皮肤 | 快，但仍是聊天页，实验室感靠装饰 | 不采用 |
| 实验仪器工作台 | 保留成熟聊天链路，增加记录、检索、复现、导出与真实观测 | **采用** |
| 多模型 Agent 云平台 | 涉及模型参数、账号、同步、工具权限，范围和安全边界完全不同 | 不纳入本期 |

核心原则：**实验室感来自可追溯的工作流，不来自更多辉光、扫描线和假仪表盘。**

---

## 2. 产品定义与验收目标

### 2.1 品牌与文案

- 产品名：`CYBER//LAB`
- 中文名：`赛博实验室`
- 页面副标题：`EXPERIMENTAL INTELLIGENCE CONSOLE`
- 主标语：`把问题变成可复现的实验。`
- 对象命名：项目 = `实验项目`，会话 = `实验`，系统指令 = `实验协议`，回答 = `观测结果`，中断回答 = `已中止的观测`。
- 技术界面保留必要英文缩写，但操作、错误、危险确认使用清晰中文，不堆砌“神经链路”“矩阵”等不可解释词汇。

### 2.2 首期完整用户闭环

1. 创建实验项目，选择或编写实验协议。
2. 创建实验，输入问题并观察真实的连接、流式、完成/中止/失败状态。
3. 为实验添加标签和结论笔记，将某条助手回答追加到笔记。
4. 搜索本地项目、实验标题、标签、笔记和消息内容并跳回原实验。
5. 通过命令面板完成高频操作，不需要记住复杂鼠标路径。
6. 导出当前实验 Markdown、完整工作区 JSON 备份。
7. 从 JSON 备份预览并合并导入，不覆盖已有实验。
8. 查看最近一次回答的首响应、首 token、总耗时、字符数、请求模型和实际路径；接口未提供的值明确显示“未提供”。

### 2.3 成功标准

- 视觉：用户无需阅读说明即可识别“项目导航—实验记录—协议/观测”三层工作区。
- 功能：已有聊天、项目、会话、协议能力无回归；新增功能均可在本地浏览器闭环。
- 数据：旧 `cyberchat.v1` 可读取；损坏的扩展数据不能导致对话被清空；导入不静默覆盖或截断。
- 可访问性：完整键盘操作、可见焦点、抽屉/弹窗焦点约束与返回、200% 缩放可用； axe 无 serious/critical 自动检查问题。
- 响应式：1440×900、1024×768、390×844、360×800 均无横向页面溢出，输入与发送始终可达。
- 性能：无外部字体/CDN/图片请求，无常驻粒子画布；流式期间不因装饰动画持续抢帧。
- 真实性：首 token 等指标来自实际测量，Token 数、模型内部状态和成本不伪造。

---

## 3. 视觉与交互设计

### 3.1 桌面布局

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ CYBER//LAB  赛博实验室     [⌘K 命令 / 搜索]      LOCAL VAULT   [在线] [观测] │
├──────────────┬───────────────────────────────────────┬───────────────────────┤
│ 实验库  [＋] │ EXP / 7F3A…        协议：代码实现 [•] │ CONFIG / OBSERVE      │
│ [搜索实验…]  │ 把问题变成可复现的实验                │───────────────────────│
│              │                                       │ 实验协议              │
│ ▾ 前端重构 3 │ ┌─ 协议卡 / 快捷实验 ───────────────┐ │ [启用] [预设]         │
│   ● API 设计 │ │ 代码实现  技术评审  调研  创意    │ │ 字符 / 历史 / 上下文  │
│   ○ 性能排查 │ └───────────────────────────────────┘ │───────────────────────│
│ ▾ 技术调研 2 │                                       │ 本次观测              │
│              │ U-01  14:32  你的输入                 │ 状态 / 首响应 / 首字  │
│              │ A-01  14:32  助手的 Markdown 回答     │ 耗时 / 字符 / 路径    │
│ [笔记] [导出]│ [复制] [加入实验笔记]                 │───────────────────────│
│              │                                       │ 标签 / 实验结论笔记   │
│ LOCAL ONLY   │ ┌───────────────────────────────────┐ │ [导出 MD] [备份 JSON] │
│ 数据仅存本机 │ │ 输入新的实验指令…       [发送 ↗] │ │ [导入] [复制诊断]     │
└──────────────┴───────────────────────────────────────┴───────────────────────┘
```

- ≥1280px：`272px / minmax(0, 1fr) / 304px`，主内容最大阅读宽度 960px。
- 1024–1279px：保留左栏，右侧观测台变为可开关抽屉。
- <768px：左栏和观测台均为抽屉；顶栏只保留菜单、品牌、命令、观测按钮。
- 移动 composer 输入字号至少 16px，主要触摸目标至少 44×44px，并处理 safe-area。

### 3.2 视觉语言

采用“深色精密仪器 + 实验记录纸面”的混合风格：

| Token | 值 | 用途 |
|---|---|---|
| `--bg` | `#07090d` | 页面底色 |
| `--surface` | `#0d1117` | 主面板 |
| `--surface-raised` | `#121820` | 抽屉、输入区 |
| `--line` | `#28333d` | 分隔线，不用发光边框代替结构 |
| `--text` | `#edf4f6` | 正文 |
| `--muted` | `#96a4af` | 次级信息 |
| `--signal` | `#68f5c2` | 主操作、完成、当前实验 |
| `--info` | `#65d9ff` | 连接和信息 |
| `--warning` | `#ffca6a` | 中止、降级、存储受限 |
| `--danger` | `#ff7185` | 错误与危险操作 |

- 中文正文使用系统 sans，15–16px、1.75 行高；等宽字体只用于编号、时间、指标、代码和短标签。
- 背景只保留低对比 24px 小网格和 96px 主网格；移除常驻粒子、透视地板、故障字和全屏扫描。
- 面板圆角 6–10px；只在品牌、当前实验和重点实验卡上使用切角，不让所有按钮都像装饰芯片。
- 用户消息不再使用大面积紫色渐变气泡；对话以时间序列实验日志呈现，角色、序号、时间和状态构成层级。
- 动画限定 120–180ms 的面板/状态过渡；只有“等待响应”允许低频率呼吸点。`prefers-reduced-motion` 下全部非必要动画关闭。
- 空状态使用 4 张有真实 prompt 的“实验协议卡”，统计数字只来自当前本地数据。

### 3.3 观测状态机

| 状态 | 页面文案 | 进入条件 |
|---|---|---|
| `idle` | 待发起实验 | 尚无在途请求 |
| `connecting` | 正在请求 `/api/chat` | fetch 已发起、响应头未到 |
| `streaming` | 正在接收观测结果 | 已收到非空 delta |
| `complete` | 本次观测已完成 | 正常完成且有内容 |
| `stopped` | 已由用户中止 | 用户停止，保留部分内容 |
| `timeout` | 无新数据，已超时 | stall timer 触发 |
| `error` | 本次观测失败 | HTTP/流内/网络错误 |
| `offline` | 浏览器当前离线 | `navigator.onLine === false` |

“在线”仅表示浏览器的网络信号，不表示模型健康；模型可用性只能由实际请求结果说明。

---

## 4. 数据、协议与安全边界

### 4.1 非破坏性数据演进

不升级也不重写 `cyberchat.v1` 的版本号。仅在消息上增加可选 `id`；旧消息读取时生成 ID 并在下一次正常保存时固定下来。新增数据分键保存：

```js
const STORAGE_KEY = 'cyberchat.v1';
const LAB_STORAGE_KEY = 'cyberlab.annotations.v1';
const UI_STORAGE_KEY = 'cyberlab.ui.v1';
```

```json
{
  "version": 1,
  "sessions": {
    "session-id": {
      "notes": "用户填写的实验结论，最多 12000 字符",
      "tags": ["代码", "待复核"],
      "runs": {
        "assistant-message-id": {
          "outcome": "complete",
          "timeToHeadersMs": 231.4,
          "timeToFirstTokenMs": 487.1,
          "durationMs": 1932.8,
          "characters": 826,
          "historyMessages": 4,
          "systemPromptCharacters": 98,
          "model": "@makers/deepseek-v4.1-flash",
          "route": "agent",
          "requestId": "server-generated-uuid"
        }
      }
    }
  }
}
```

- 标签最多 6 个，每个 trim 后 1–20 字符，去重，不支持嵌套对象。
- `model` 表示请求给网关的模型，不宣称证明模型内部实际版本；`route` 只能是 `agent`、`gateway`、`unknown`。
- 扩展存储损坏时只重建扩展默认态，绝不清空 `cyberchat.v1`。
- 旧前端回滚后可能忽略新增消息 ID，但对话内容仍可读；独立笔记键保留，重新升级后可恢复。

### 4.2 导出与导入

- 单实验 Markdown 包含：标题、项目、引用 ID、创建/更新时间、标签、有效实验协议、实验笔记、按时间排序的对话。
- 完整备份 JSON 格式固定为：

```json
{
  "format": "cyberlab.backup",
  "version": 1,
  "exportedAt": "ISO-8601 string",
  "chat": { "version": 1, "activeProjectId": "id", "projects": [] },
  "annotations": { "version": 1, "sessions": {} }
}
```

- 文件上限 5 MiB；只接受 JSON 备份，不能依据扩展名或 MIME 信任内容。
- 导入前显示项目、实验、消息、笔记、标签数量及超限错误。
- 当前容量与导入容量合并后若超过 50/100/200 或文本上限，整个导入拒绝并指出具体项目，不静默截断。
- 采用“合并导入”：为导入的项目、会话、消息生成新 ID，并重建 annotations 映射；当前 activeProjectId 不变，不覆盖同名项目。
- 先构造完整候选状态，再一次提交内存与存储；写入失败时不把 UI 报告为成功，已有对话不得被删除。
- 文件名去除控制字符和 `/\\?%*:|"<>`，标题最长 48 字符；Blob URL 在下载后 revoke。
- 导出前提示“文件含对话和实验协议，请勿上传含私密内容的备份”。

### 4.3 Markdown、DOM 与诊断

- 用户/助手/笔记/标签/导入内容继续使用 `textContent` 或 Text 节点。
- 不启用原始 HTML、外部图片或任意链接协议；如增加链接，只允许 `https:`、`http:`，并使用 `rel="noopener noreferrer nofollow"`。
- 代码块提供复制和自动换行切换，不引入大型语法高亮器。
- “复制诊断”只包含状态码、计时、路由、请求 ID、模型和错误类别，不包含消息、系统指令、Cookie、鉴权 URL 或环境变量。

### 4.4 后端观测协议

SSE 帧仍只有：

```text
data: {"delta":"..."}\n\n
data: {"error":"..."}\n\n
data: [DONE]\n\n
```

新增响应头，不增加新 SSE 事件：

```text
X-Request-Id: <random UUID>
X-AI-Model: <实际写入上游请求的 model>
X-AI-Route: agent | gateway
Access-Control-Expose-Headers: X-Request-Id, X-AI-Model, X-AI-Route
```

- Agent 成功透传时 `X-AI-Route: agent`；回环失败并直连时 `X-AI-Route: gateway`。
- HTTP 校验错误也带 `X-Request-Id`，但不虚构 `X-AI-Route` 或首 token。
- 不返回 API Key、Gateway base URL、Cookie、堆栈或鉴权查询参数。
- `agents/_chat.ts` 与 `cloud-functions/api/chat.js` 的模型、提示词和校验语义继续用同一组契约 fixture 验证。

---

## 5. 目标文件结构

```text
index.html                         # 语义化工作台骨架、dialog、抽屉和 live region
style.css                          # tokens、基础元素、桌面布局、消息和 composer
styles/lab.css                     # 实验库、观测台、命令面板、笔记与响应式规则
app.js                             # 应用组合、在途请求、事件协调；不再包含全部纯函数
scripts/core/state.js              # cyberchat.v1、消息 ID、历史裁剪、请求体
scripts/core/chat-protocol.js      # SSE parser、delta 提取、错误分类
scripts/core/lab-data.js           # annotations/UI 存储、搜索、导入导出纯函数
scripts/core/telemetry.js          # RunTelemetry、状态转换和可序列化诊断
scripts/ui/dom.js                  # createEl、硬编码 SVG、时间/文件名格式化
scripts/ui/markdown.js             # 安全 Markdown、代码块和回答操作节点
scripts/ui/dialogs.js              # dialog、抽屉焦点、命令面板可访问性行为
tests/unit/*.test.ts               # 状态、SSE、笔记、搜索、导入导出、遥测
tests/contract/chat-paths.test.ts   # 两条后端路径的同输入/同输出契约
tests/e2e/workbench.spec.ts        # 关键浏览器工作流，网关全部 mock
tests/e2e/accessibility.spec.ts    # 键盘、焦点、axe 和 reduced-motion
tests/support/static-server.mjs    # 仅测试用静态服务器，不含生产逻辑
playwright.config.ts               # 桌面/移动项目、失败截图和 trace
tsconfig.json                      # TypeScript 静态检查，不生成构建产物
TECHNICAL_DOC.md                   # 更新真实架构、存储、响应头和验收结果
README.md                          # 本地运行、测试命令和功能说明
```

不新增运行时 npm 依赖。开发依赖只包括 `@playwright/test`、`@axe-core/playwright`、`@types/node`、`tsx`、`typescript`，具体版本由实施时 npm 解析并锁定到 `package-lock.json`。

---

## 6. 分阶段实施任务

## Phase A：可验证基线与核心解耦

### Task A1：建立功能分支和测试基线

**Files:**
- Create: `tests/support/static-server.mjs`
- Create: `tests/e2e/legacy-workflows.spec.ts`
- Create: `playwright.config.ts`
- Modify: `package.json`, `package-lock.json`, `tsconfig.json`

- [ ] **Step 1：从已同步的 main 建功能分支，不创建部署**

```bash
git status --short --branch
git switch -c feat/cyber-lab-upgrade
```

预期：工作区只有用户已允许纳入的变更；不能把 `.env`、`.edgeone/` 或已有无关修改带入提交。

- [ ] **Step 2：加入可执行脚本和开发依赖**

```json
{
  "scripts": {
    "build": "node -e \"console.log('[ai-chat-assistant] 纯静态前端，无需构建；请运行 npm run check')\"",
    "check": "node --check app.js && tsc --noEmit && npm test && git diff --check",
    "test": "npm run test:unit && npm run test:contract",
    "test:unit": "tsx --test tests/unit/*.test.ts",
    "test:contract": "tsx --test tests/contract/*.test.ts",
    "test:e2e": "playwright test"
  }
}
```

执行：

```bash
npm install --save-dev @playwright/test @axe-core/playwright @types/node tsx typescript
npx playwright install chromium
```

- [ ] **Step 3：先写旧行为浏览器测试，并确认旧页面通过**

覆盖：首次默认项目、创建/切换/重命名/删除、刷新恢复、协议开关、4000/4001 字、发送、停止、重试、移动抽屉、中文输入法。所有 `/api/chat` 用 Playwright route mock。

```ts
await page.route('**/api/chat', async (route) => {
  await route.fulfill({
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    body: 'data: {"delta":"基线"}\n\ndata: {"delta":"回复"}\n\ndata: [DONE]\n\n',
  });
});
await page.getByLabel('输入消息').fill('验证基线');
await page.getByRole('button', { name: '发送消息' }).click();
await expect(page.locator('#messages')).toContainText('基线回复');
```

- [ ] **Step 4：运行并保存基线证据**

```bash
npm run test:e2e -- --project=chromium
```

预期：旧功能测试全通过；任何真实旧缺陷先记录复现步骤并单独修复，不能在重构提交中夹带行为变化。

- [ ] **Step 5：提交测试基线**

```bash
git add package.json package-lock.json tsconfig.json playwright.config.ts tests
git commit -m "补充工作台回归测试基线"
```

### Task A2：锁定纯函数和双路径契约

**Files:**
- Create: `tests/unit/state.test.ts`
- Create: `tests/unit/chat-protocol.test.ts`
- Create: `tests/contract/chat-paths.test.ts`
- Create: `tests/fixtures/chat-contract.json`

- [ ] **Step 1：写状态与协议 fixture**

必须覆盖：坏 JSON、空 projects、重复 ID、失效 active ID、非字符串 content、存储读写抛错、40 条/50000 字裁剪、首条 user、4000/4001 协议、60/61 消息、60000/60001 总字符。

```ts
test('空白 systemPrompt 不出现在请求体', () => {
  const body = buildRequestBody(
    [{ role: 'user', content: '测试', ts: 1 }],
    ' \n ',
  );
  assert.deepEqual(body, { messages: [{ role: 'user', content: '测试' }] });
  assert.equal(Object.hasOwn(body, 'systemPrompt'), false);
});
```

- [ ] **Step 2：写逐字节和拆 UTF-8 的 SSE 测试**

```ts
test('任意分块仍输出一次完整内容并忽略 DONE 后的数据', () => {
  const frames = [
    'data: {"delta":"你"}\n\n',
    'data: {"delta":""}\n\n',
    'data: {"delta":"好"}\r\n\r\n',
    'data: [DONE]\n\n',
    'data: {"delta":"不应出现"}\n\n',
  ].join('');
  const bytes = new TextEncoder().encode(frames);
  const events = [];
  const parser = createSSEParser((event) => events.push(JSON.parse(event)));
  for (const byte of bytes) parser.feed(new Uint8Array([byte]));
  parser.finish();
  assert.deepEqual(events, [{ delta: '你' }, { delta: '' }, { delta: '好' }]);
  assert.equal(parser.finished, true);
});
```

- [ ] **Step 3：让 Agent 与函数路径消费同一 fixture**

断言：HTTP 400 不调用 fetch；两条路径的有效请求组装相同 system messages；空 delta 是心跳；错误帧后收尾；取消会 abort 上游并清理 timer；proxy 401/404/5xx/非 SSE 会降级。

- [ ] **Step 4：先确认测试能发现行为差异，再运行完整基线**

预期：正常用例通过；故意把 fixture 中 4000 改为 4001 时边界测试失败，随后恢复 fixture。不得通过放宽断言让错误实现通过。

- [ ] **Step 5：提交契约测试**

```bash
git add tests
git commit -m "锁定对话状态与双路径接口契约"
```

### Task A3：原生 ES module 解耦，保持 DOM 行为

**Files:**
- Create: `scripts/core/state.js`, `scripts/core/chat-protocol.js`, `scripts/ui/dom.js`, `scripts/ui/markdown.js`
- Modify: `app.js`, `index.html`
- Modify: `tests/unit/state.test.ts`, `tests/unit/chat-protocol.test.ts`

- [ ] **Step 1：先改测试为直接导入目标模块**

```ts
import {
  buildRequestBody,
  createStorage,
  normalizeState,
  trimHistory,
} from '../../scripts/core/state.js';
import { createSSEParser, extractDelta } from '../../scripts/core/chat-protocol.js';
```

保持 Task A2 的 fixture 和断言不变；此时运行应因模块不存在而失败。

- [ ] **Step 2：迁移实现，不重新设计算法**

`app.js` 通过具名 import 使用核心函数，页面改为：

```html
<script type="module" src="./app.js"></script>
```

移除 `__CYBERCHAT_SELFTEST__` 生产分支和全局测试导出；测试直接导入纯模块。所有内部 import 显式带 `.js`，保证浏览器和 tsx 使用同一文件。

- [ ] **Step 3：运行静态检查、单测和旧浏览器工作流**

```bash
npm run check
npm run test:e2e
```

预期：全部通过，页面请求没有 CommonJS/`require` 错误；聊天记录和 XSS fixture 结果不变。

- [ ] **Step 4：手工核对在途切换**

发送延迟流，在首段文本后切到另一会话，再释放后续 delta。预期：旧会话保存部分回答并标记 stopped，新会话不出现旧 delta 或错误气泡。

- [ ] **Step 5：提交纯重构**

```bash
git add index.html app.js scripts tests
git commit -m "拆分前端状态与流式协议模块"
```

---

## Phase B：CYBER//LAB 工作台与可访问性

### Task B1：重建语义骨架和设计 tokens

**Files:**
- Modify: `index.html`, `style.css`
- Create: `styles/lab.css`
- Modify: `scripts/ui/dom.js`
- Modify: `tests/e2e/workbench.spec.ts`

- [ ] **Step 1：先更新可观察文案和结构断言**

断言品牌为 CYBER//LAB、左侧为实验库、中间为实验日志、右侧为协议/观测；初始文案不能出现“神经链路已连接”或虚构 token。

- [ ] **Step 2：实现第 3 节布局与 tokens**

保留现有业务元素的稳定 ID，新增元素采用 `lab-` 前缀。移除 canvas、故障标题、透视地板和大面积渐变；增加命令入口、右侧 inspector、笔记区和状态 live region。

- [ ] **Step 3：实现真实空状态**

四张协议卡分别填入代码实现、技术评审、技术调研、创意发散 prompt；点击只填入输入框并聚焦，不自动发送，避免用户未确认就发起模型请求。本地统计从 state 计算。

- [ ] **Step 4：截图和静态验收**

```bash
npm run check
npm run test:e2e -- --project=chromium
```

检查 1440×900、1024×768、390×844 的空/有消息/长代码/错误状态截图。预期：正文清晰、主操作唯一、无装饰遮挡、无横向页面滚动。

- [ ] **Step 5：提交视觉系统**

```bash
git add index.html style.css styles scripts/ui tests/e2e
git commit -m "重构赛博实验室工作台视觉"
```

### Task B2：响应式抽屉、dialog 与键盘可达性

**Files:**
- Create: `scripts/ui/dialogs.js`
- Modify: `app.js`, `index.html`, `styles/lab.css`
- Create: `tests/e2e/accessibility.spec.ts`

- [ ] **Step 1：写焦点和键盘失败测试**

覆盖：打开/关闭项目栏与观测台、Escape、Tab 循环、关闭后焦点回触发按钮、命令/重命名 dialog、后台 inert、200% 缩放、触摸目标、axe。

```ts
await page.getByRole('button', { name: '打开观测台' }).click();
await expect(page.getByRole('complementary', { name: '实验观测台' })).toBeVisible();
await page.keyboard.press('Escape');
await expect(page.getByRole('button', { name: '打开观测台' })).toBeFocused();
```

- [ ] **Step 2：实现统一 overlay 管理**

弹窗使用原生 `<dialog>`；抽屉记录触发元素，打开时让后台 inert，关闭时恢复。嵌套 overlay 只允许一个栈顶响应 Escape，不允许关闭观测台时同时中止生成。

- [ ] **Step 3：实现非打扰式通知**

`role="status" aria-live="polite"` 只宣布“已开始/已完成/已停止/失败/导入结果”，不逐 delta 朗读；消息区在流式时不逐字触发 live announcement。

- [ ] **Step 4：运行桌面、移动和 reduced-motion 测试**

```bash
npm run test:e2e
```

预期：键盘全流程通过，axe 无 serious/critical；reduced-motion 下不存在持续动画，功能不依赖动画结束事件。

- [ ] **Step 5：提交可访问性改进**

```bash
git add index.html app.js styles scripts/ui tests/e2e
git commit -m "完善实验室键盘与移动端交互"
```

### Task B3：真实请求状态和流式阅读体验

**Files:**
- Create: `scripts/core/telemetry.js`
- Create: `tests/unit/telemetry.test.ts`
- Modify: `app.js`, `index.html`, `style.css`

- [ ] **Step 1：先写状态转换和计时测试**

使用注入时钟，不依赖真实等待：

```js
export function createRunTelemetry(now = () => performance.now()) {
  const startedAt = now();
  let headersAt = null;
  let firstTokenAt = null;
  return {
    markHeaders() {
      if (headersAt === null) headersAt = now();
    },
    markToken() {
      if (firstTokenAt === null) firstTokenAt = now();
    },
    finish(outcome) {
      const endedAt = now();
      return {
        outcome,
        timeToHeadersMs: headersAt === null ? null : headersAt - startedAt,
        timeToFirstTokenMs: firstTokenAt === null ? null : firstTokenAt - startedAt,
        durationMs: endedAt - startedAt,
      };
    },
  };
}
```

断言：重复 markToken 不覆盖首值；无 token 的错误返回 null；stopped/timeout 不被改成 complete；空心跳不算 token。

- [ ] **Step 2：把现有 setStreaming 扩展为显式状态机**

连接、接收、完成、停止、超时、HTTP/流内错误分别进入对应状态；浏览器 online/offline 只更新网络徽标，不能覆盖在途请求状态。

- [ ] **Step 3：优化长回答阅读**

保持流式 Text 节点追加，完成后再渲染 Markdown；代码块有复制/换行，长消息不会撑破布局。用户主动向上滚动时不自动拉回底部，“回到最新”显示未读状态。

- [ ] **Step 4：验证停止、超时和错误后的最终状态**

预期：停止保留部分内容并标 stopped；错误有重试；切换会话不会把状态写到新实验；界面不显示“已连接模型”之类未证明结论。

- [ ] **Step 5：提交状态与阅读体验**

```bash
git add app.js index.html style.css scripts tests
git commit -m "改进实验运行状态与流式阅读"
```

---

## Phase C：实验记录、检索、命令与数据工具

### Task C1：独立实验笔记和标签数据层

**Files:**
- Create: `scripts/core/lab-data.js`
- Create: `tests/unit/lab-data.test.ts`
- Modify: `scripts/core/state.js`

- [ ] **Step 1：先写旧数据、损坏数据和回滚兼容测试**

覆盖：无消息 ID 的旧消息、重复 ID、笔记 12000 字边界、标签去重/6 个/20 字、扩展存储 SecurityError、损坏 annotations 不影响 chat、UI 设置非法值回默认。

- [ ] **Step 2：实现独立存储和 normalize**

提供明确接口：

```js
normalizeAnnotations(raw);
createAnnotationStorage(store);
getSessionAnnotation(annotations, sessionId);
updateSessionAnnotation(annotations, sessionId, patch);
normalizeTags(value);
```

`updateSessionAnnotation` 返回新对象，不在渲染过程中隐式修改原状态；每次更新设置 `updatedAt`，但不改变消息时间。

- [ ] **Step 3：为消息提供稳定可选 ID**

新消息使用 `crypto.randomUUID()` 并保留现有降级；旧消息加载时生成，重复 ID 在当前会话内重新生成。历史裁剪和重试不能复用另一条消息的 ID。

- [ ] **Step 4：运行全部数据回归**

```bash
npm run test:unit
```

预期：旧 `cyberchat.v1` 的消息逐字保留，坏扩展只显示“实验扩展数据不可用”，不清空聊天。

- [ ] **Step 5：提交数据层**

```bash
git add scripts/core tests/unit
git commit -m "增加兼容旧会话的实验数据层"
```

### Task C2：观测台中的协议、笔记和回答沉淀

**Files:**
- Modify: `app.js`, `index.html`, `styles/lab.css`
- Modify: `tests/e2e/workbench.spec.ts`

- [ ] **Step 1：先写浏览器工作流测试**

创建实验 → 添加标签 → 写笔记 → 刷新恢复 → 切换实验隔离 → 将助手回答加入笔记 → 删除会话后清理其 annotations → 损坏扩展恢复。

- [ ] **Step 2：实现协议面板**

把现有系统指令能力迁移到 inspector，不复制第二套状态。顶栏和 composer 只显示摘要，所有编辑仍调用同一个 `persistSysFromUI` 等价流程；4001 字仍不得发送或保存。

- [ ] **Step 3：实现笔记和标签编辑**

笔记 300ms 防抖保存，pagehide 前 flush；标签用可删除按钮和文本输入，不用逗号粘贴构造 HTML。“加入实验笔记”追加完整回答和时间标题，并在按钮上给出已加入反馈。

- [ ] **Step 4：验证存储失败和删除边界**

存储失败显示持久警告，不能只闪一个 toast；删除项目/会话只清理对应扩展数据，取消删除不修改任何状态。

- [ ] **Step 5：提交实验记录能力**

```bash
git add app.js index.html styles tests
git commit -m "加入实验笔记标签与回答沉淀"
```

### Task C3：全局搜索与命令面板

**Files:**
- Modify: `scripts/core/lab-data.js`, `scripts/ui/dialogs.js`, `app.js`, `index.html`, `styles/lab.css`
- Create: `tests/unit/search.test.ts`
- Create: `tests/e2e/command-palette.spec.ts`

- [ ] **Step 1：写搜索排序和命令执行测试**

搜索范围：项目名、实验标题、标签、笔记、消息；大小写和首尾空白归一；结果显示项目/实验路径和安全纯文本 snippet。排序为：标题精确 > 标题前缀 > 标签 > 笔记 > 消息，最近更新作次级排序；最多 50 条。

- [ ] **Step 2：实现纯搜索函数**

```js
searchWorkspace({ chat, annotations }, query, { limit: 50 });
```

空查询返回最近实验而不是全部消息；150ms 防抖； snippet 以命中点为中心，最多 120 字符，不用 innerHTML 高亮。

- [ ] **Step 3：实现命令注册表**

首批命令固定为：新建项目、新建实验、聚焦输入、切换观测台、复制当前实验、导出 Markdown、备份 JSON、导入备份、停止当前生成。命令按当前状态 enabled/disabled；没有流式请求时停止项禁用。

- [ ] **Step 4：实现 Cmd/Ctrl+K 与列表键盘**

上下键移动、Enter 执行、Escape 关闭、输入组合期间不误执行；触发后焦点回合理位置。侧栏只展示已实现的快捷键。

- [ ] **Step 5：运行搜索、命令和中文输入法回归**

预期：跳转到结果时展开所属项目并选中实验；旧在途流仍按世代机制处理；命令不重复绑定、不触发两次请求。

- [ ] **Step 6：提交效率功能**

```bash
git add app.js index.html styles scripts tests
git commit -m "加入实验搜索与命令面板"
```

### Task C4：Markdown 导出、JSON 备份与合并导入

**Files:**
- Modify: `scripts/core/lab-data.js`, `app.js`, `index.html`, `styles/lab.css`
- Create: `tests/unit/transfer.test.ts`
- Create: `tests/e2e/data-transfer.spec.ts`

- [ ] **Step 1：先写序列化往返和恶意输入测试**

覆盖：Markdown 特殊字符、代码围栏、中文标题、文件命名、Blob revoke、5 MiB 边界、坏 JSON、错误 format/version、超容量、重复 ID、原型污染键、XSS 文本、写入失败、取消导入。

```ts
test('导入合并不覆盖当前项目且重建引用', () => {
  const result = buildMergedImport(currentChat, currentAnnotations, validBackup, idFactory);
  assert.equal(result.chat.activeProjectId, currentChat.activeProjectId);
  assert.equal(result.chat.projects.length, currentChat.projects.length + 1);
  assert.notEqual(result.chat.projects.at(-1).id, validBackup.chat.projects[0].id);
  assert.equal(result.annotations.sessions[result.chat.projects.at(-1).sessions[0].id].notes, '保留笔记');
});
```

- [ ] **Step 2：实现纯导出和严格预检**

提供：

```js
serializeSessionMarkdown(project, session, annotation);
createWorkspaceBackup(chat, annotations, exportedAt);
inspectWorkspaceBackup(text, byteLength);
buildMergedImport(chat, annotations, backup, idFactory);
```

`inspectWorkspaceBackup` 返回统计或字段级中文错误；只有全部验证通过才允许确认按钮可用。

- [ ] **Step 3：实现预览 dialog 和原子提交**

确认页列出导入数量、容量余量和“不会覆盖同名项目”；确认后才修改 state。成功后显示新增数量并保留当前选中实验，失败保留原页面和原数据。

- [ ] **Step 4：浏览器验证下载和恢复**

用 Playwright download 事件读取文件，再通过文件 chooser 导入；刷新后核对消息、标签、笔记和 ID 引用。注入包含 `<img onerror>` 的消息，页面只能显示文本。

- [ ] **Step 5：提交数据工具**

```bash
git add app.js index.html styles scripts tests
git commit -m "加入实验导出与安全备份导入"
```

---

## Phase D：真实遥测、文档与发布

### Task D1：两条后端路径返回一致的观测响应头

**Files:**
- Modify: `cloud-functions/api/chat.js`
- Modify: `agents/chat/index.ts`, `agents/_shared.ts`, `agents/_chat.ts`
- Modify: `tests/contract/chat-paths.test.ts`

- [ ] **Step 1：先写 Agent/降级路径响应头测试**

分别 mock：Agent 2xx SSE、Agent 401 后 gateway 成功、Agent 12s 超时后 gateway 成功、gateway 错误、HTTP 400。断言 request ID 格式、model 与实际 fetch body 一致、route 正确、无 key/baseURL/Cookie 泄露。

- [ ] **Step 2：在统一响应头组装处实现**

`/api/chat` 每次请求生成一个 request ID，代理和直连响应复用该 ID；模型来自本次 `resolveGateway` 结果。`_shared.ts` 的响应封装允许附加安全 headers，但不改 `sseData` 帧结构。

- [ ] **Step 3：验证超时、取消与收尾没有回归**

预期：reader cancel、AbortSignal、heartbeat interval、idle/hard timer 均清理；直连失败仍发送既有 error + DONE；不允许为了添加 headers 缓冲完整流。

- [ ] **Step 4：运行契约测试**

```bash
npm run test:contract
```

预期：主路径和降级路径除 route 外具有一致的业务契约；HTTP 400 零上游调用。

- [ ] **Step 5：提交后端观测能力**

```bash
git add cloud-functions agents tests/contract
git commit -m "补充聊天双路径运行观测响应头"
```

### Task D2：把真实遥测写入当前实验

**Files:**
- Modify: `app.js`, `scripts/core/telemetry.js`, `scripts/core/lab-data.js`, `index.html`, `styles/lab.css`
- Modify: `tests/unit/telemetry.test.ts`, `tests/e2e/workbench.spec.ts`

- [ ] **Step 1：写 headers 缺失、分块和刷新恢复测试**

mock 响应分别包含有/无观测 headers；断言缺失时显示“未提供”，首响应/首 token/总耗时来自注入时钟，字符数来自最终内容，刷新后最近运行记录仍可查看。

- [ ] **Step 2：接入响应头和计时**

在 fetch resolve 时读取 headers 并 `markHeaders()`；仅非空 delta 调用 `markToken()`；结束时写入 assistant message ID 对应的 run。不得用字符数估算 token。

- [ ] **Step 3：实现观测台与诊断复制**

指标包括状态、请求模型、实际路径、请求 ID、首响应、首 token、总耗时、字符数、历史消息数、协议字符数。错误时显示错误类别和重试，不展示完整敏感错误正文到诊断导出。

- [ ] **Step 4：验证 route 与状态的组合**

Agent 成功、gateway 降级、无内容、流内错误、停止、超时各运行一次 mock；页面不得把 gateway 降级显示为 Agent，也不得把停止显示为完整回答。

- [ ] **Step 5：提交真实遥测**

```bash
git add app.js index.html styles scripts tests
git commit -m "接入实验真实耗时与路径观测"
```

### Task D3：全量验收、文档和受控发布

**Files:**
- Modify: `README.md`, `TECHNICAL_DOC.md`, `AGENTS.md`（仅当实际命令或结构变化需要同步）
- Create: `tests/e2e/resilience.spec.ts`

- [ ] **Step 1：补齐韧性测试**

覆盖：逐字节 SSE、多行 data、心跳、错误后部分回答、DONE 后数据、offline/online、localStorage 读写异常、坏备份、连续快速切换、重复点击、后台页恢复、200% 缩放和 reduced-motion。

- [ ] **Step 2：运行完整静态与自动化验收**

```bash
npm ci
npm run check
npm run test:e2e
npm run build
```

报告分别写：依赖安装结果、静态检查、单元/契约测试数量、浏览器测试数量、build 的 no-op 输出。禁止把 build 写成打包或功能验证。

- [ ] **Step 3：启动真实本地预览并人工验收**

```bash
command -v edgeone
edgeone -v
PAGES_SOURCE=skills edgeone whoami
PAGES_SOURCE=skills edgeone makers dev --name ai-chat-assistant --skip-env-sync
```

打开 `http://127.0.0.1:8088/`，验证真实多轮、协议开/关、4000/4001、停止、长 Markdown、移动布局、搜索、笔记、导出和备份导入。若本地缺网关配置，明确标记真实聊天未验证，不用 mock 结果替代。

- [ ] **Step 4：检查静态发布边界与暂存清单**

```bash
git status --short
git diff --check
git check-ignore -v .env .edgeone/auth.json
```

确认新增测试和 docs 会随 `outputDirectory: "."` 被公开，不包含鉴权 URL、真实用户对话、密钥、截图中的隐私或本地路径凭证；敏感临时文件放项目外。

- [ ] **Step 5：更新文档并创建供审阅的提交**

README 写运行/测试/功能；技术文档写模块、三存储键、备份格式、响应头、真实验证结果和限制。保留历史存档内容时新增章节，不把旧实测写成当前实测。

```bash
git add README.md TECHNICAL_DOC.md AGENTS.md docs tests
git commit -m "完善赛博实验室文档与发布验收"
```

- [ ] **Step 6：仅在用户授权发布时先部署 preview**

停止同目录 dev 后执行：

```bash
PAGES_SOURCE=skills edgeone makers deploy -e preview --json
```

记录项目名、deployment ID 和验证结果；完整鉴权 URL 只提供给用户，不写入仓库。preview 上重复真实聊天和浏览器验收后，再由用户决定是否合并/push main。main 自动部署后必须核对该提交的部署结果和线上功能。

---

## 7. 最终验收矩阵

| 范围 | 必须通过的可观察行为 | 证据 |
|---|---|---|
| 视觉 | 三栏仪器工作台；信号色克制；无假指标和常驻炫技动画 | 桌面/移动/长回答截图 |
| 项目与实验 | 新建、切换、重命名、删除、刷新恢复；在途切换不串流 | 单元 + E2E |
| 协议 | 开关、预设、4000/4001；前端摘要和后端请求一致 | 边界契约 + 真实请求 |
| 流式 | 任意分块、UTF-8、CRLF、多行、心跳、错误、DONE、停止 | 单元 + 契约 + 本地预览 |
| 笔记 | 标签/笔记隔离、刷新恢复、回答追加、删除清理 | E2E |
| 搜索/命令 | 排序、跳转、键盘、IME、禁用状态 | 单元 + E2E |
| 导入导出 | 往返一致、5 MiB、超容量拒绝、合并不覆盖、XSS 安全 | 单元 + 下载/上传 E2E |
| 遥测 | Agent/gateway 标识正确；缺失显示未提供；无伪 token | 契约 + mock E2E |
| 可访问性 | 焦点、Escape、live region、44px、200%、reduced-motion | Playwright + axe + 人工键盘 |
| 存储韧性 | 对话与扩展故障隔离；回滚不丢主对话 | 故障注入测试 |
| 发布 | preview 实测后再生产；部署对应提交，聊天真实可用 | CLI 结果 + 线上验证 |

---

## 8. 性能预算与测量方式

- 首屏无外部请求；不加载 web font、图片、粒子库或语法高亮库。
- 首屏自有 JavaScript 未压缩总量目标 ≤180 KiB，CSS ≤90 KiB；超出时先拆非首屏数据工具，不用框架解决体积。
- 搜索 150ms 防抖、最多 50 结果；在当前浏览器真实数据量下目标输入响应 <100ms。
- 流式 Text 节点更新通过既有 requestAnimationFrame 滚动调度，不对每个 delta 重建整个消息列表。
- 隐藏页面停止非必要视觉更新；所有 interval/timeout/listener 在对应流程结束时清理。
- 用 Playwright trace 和浏览器 Performance 记录长流式、打开观测台和搜索，不把实验室里的计时数字当作 Lighthouse 分数。

---

## 9. 明确不在本期范围

- 多模型切换、temperature/top_p 滑块、费用统计：需要双路径请求契约、模型能力和计费依据，不能先做假控件。
- 并排 A/B 实验：需要冻结每次运行的协议/模型快照，而不是让两个会话共享后续会变化的项目协议。
- 附件、RAG、网页抓取、代码执行：涉及上传限制、解析隔离、网络安全和沙箱。
- 登录、团队、云同步、分享链接：需要账号、访问控制、隐私策略和服务端存储。
- 自定义 Agent 工具、自动执行命令、插件市场：需要独立权限模型和审计。
- PWA、桌面客户端、完整语法高亮：当前不服务核心实验闭环。

这些项目可进入下一版，但不得以 disabled 假按钮或“即将上线”占位卡片出现在首期主界面。

---

## 10. 风险与回滚

| 风险 | 控制 |
|---|---|
| 视觉重构破坏既有聊天 | 先建浏览器基线，结构/视觉/功能分提交 |
| 双路径行为漂移 | 同一 fixture 驱动 Agent 和函数直连，改动必须同时检查两文件 |
| 本地数据升级丢失 | 主键版本不变，扩展独立存储，导入只合并，失败不清空 |
| 指标造成虚假可观测 | 只显示实测值和响应头，缺失为 null/未提供 |
| 动画和流式渲染争帧 | 移除常驻 canvas，流式只追加 Text，完成后渲染 Markdown |
| 备份带私密内容外泄 | 明示导出范围，诊断排除正文，仓库和日志不存真实备份 |
| main 推送直接上线 | 功能分支 + preview 门槛 + 用户明确发布授权 |
| 回滚丢失笔记 | 回滚只回滚代码，不删除 `cyberlab.annotations.v1`；对话主键继续可读 |

回滚时不得执行 localStorage 清理脚本，也不得用“重新初始化”修复数据问题。若后端 headers 上线异常，可回退前端遥测展示而不影响 delta/error/DONE 主链路。

---

## 11. 交付节奏

1. **里程碑 A：** 测试可运行、核心解耦、旧功能外观不变。
2. **里程碑 B：** 新工作台可看、可用、可键盘操作，真实状态替代装饰状态。
3. **里程碑 C：** 笔记、搜索、命令、导出导入形成完整实验闭环。
4. **里程碑 D：** 双路径真实遥测、文档、preview 与生产验收。

每个里程碑都可独立验收和停止；不能把后续功能未做作为前一里程碑“完成”的隐含条件。实施报告按“静态检查通过 / 自动化测试通过 / 本地真实功能通过 / preview 通过 / 生产通过”分别陈述。
