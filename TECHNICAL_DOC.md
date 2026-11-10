# NEON//CHAT 技术文档

> 面向接手开发的工程师 / Codex。最后更新：2026-11-10。
>
> ⚠️ **本文件位于项目根目录，会随静态资源一起部署并可被公网读取**。因此文档刻意不包含任何 API Key、鉴权 Token、账号 ID 或带 `eo_token` 的完整访问链接。请勿往此文件里写入凭据。
>
> 文中标注：**【事实】**＝已在生产环境或本机实测；**【文档】**＝来自平台官方文档；**【建议】**＝尚未验证的后续方案。

---

## 1. 项目概览

| 项 | 内容 |
|---|---|
| 名称 | AI 聊天助手（前端品牌 `NEON//CHAT`） |
| 平台 | EdgeOne Makers（中国站登录，部署区域为 global area） |
| 项目名 / Project ID | `ai-chat-assistant` / `makers-mi6u25qnfxbx` |
| 前端 | 纯静态 `index.html` + `style.css` + `app.js`，零框架、零构建、零外部 CDN |
| 后端 | Cloud Functions (`cloud-functions/`) 薄代理 + Agent 运行时 (`agents/`) |
| 模型 | `@makers/deepseek-v4.1-flash`（固定，前端不感知、无切换 UI） |
| LLM 通道 | 平台自动注入的 AI Gateway，**不需要任何第三方 API Key** |
| 持久化 | 浏览器 `localStorage`，单 key `cyberchat.v1`（无服务端存储、无账号体系） |
| 线上状态 | 已上线并通过接口实测；访问地址以 `edgeone makers deploy --json` 输出的完整 `url` 为准（含鉴权参数，勿写入仓库） |

---

## 2. 目录结构与文件职责

```
ai-chat-assistant/
├── index.html                 # 页面骨架：顶栏 / 项目侧栏 / 聊天区 / composer / 抽屉 / 弹窗
├── style.css                  # 赛博朋克霓虹主题（约 1088 行）
├── app.js                     # 前端全部逻辑（约 1808 行），纯核心层 + DOM 应用层
├── TECHNICAL_DOC.md           # 本文件
├── package.json               # 零依赖，build 为 no-op（纯静态无需构建）
├── package-lock.json
├── edgeone.json               # 部署配置：outputDirectory "."，agents.framework "deepagents"
├── .env.example               # ⚠️ 必须入库：CLI 靠它识别并自动注入 AI_GATEWAY_*
├── .env                       # ⚠️ 本地明文网关密钥，已被 .gitignore 排除，绝不入库
├── .gitignore
├── cloud-functions/
│   └── api/chat.js            # POST /api/chat 对外入口（校验 + 双路径推理 + SSE）
└── agents/
    ├── chat/index.ts          # POST /chat 平台 Agent 端点（自动注册）
    ├── _chat.ts               # 校验、中文基础 system prompt、上游 SSE → 契约帧
    ├── _model.ts              # AI Gateway 环境变量解析、默认模型
    └── _shared.ts             # SSE 帧构造、5s 心跳、createSSEResponse
```

**路由规则【文档】**：`cloud-functions/api/<name>.js` → `/api/<name>`；`agents/<name>/index.ts` → `POST /<name>`。`_` 前缀文件是内部模块，不会被注册成路由。

---

## 3. 架构与数据流

```
浏览器 app.js
   │ POST /api/chat  { messages, systemPrompt? }
   ▼
cloud-functions/api/chat.js  ── validate() 校验 + 归一
   │
   ├─ 主路径：把 rawText 原样转发 POST /chat（带 makers-conversation-id）
   │            └─ agents/chat/index.ts → _chat.ts → AI Gateway（SSE 透传）
   │
   └─ 降级路径：当回环 4xx/5xx/非 SSE/12s 首字节超时/网络错误时
                └─ 函数内直接调 AI Gateway，输出同协议 SSE
```

**为什么有两条路径【事实】**：线上预览域名带 `eo_token` 鉴权，函数内回环到公开 origin 不携带该参数，可能被 CDN 拦截；因此任何非「2xx + SSE + 有 body」的回环响应都会自动降级为直连网关。`PREFER_AGENT_PROXY`（`chat.js:64`）置 `false` 可强制始终直连，输出协议等价。

**模型组装**（两处逻辑同名同语义）：
```js
[
  { role: 'system', content: BASE_SYSTEM_PROMPT },              // 中文/不编造/不输出内部标签
  ...(custom ? [{ role: 'system',
        content: '【项目系统指令 · 优先级更高】\n' + custom }] : []),
  ...messages                                                    // 完整多轮历史
]
```
不传 `systemPrompt` 时退化为单条 system，与旧版行为一致。用户指令绝不拼进 `user.content`，也不塞隐藏指令。

---

## 4. 接口文档

### 4.1 `POST /api/chat`（对外唯一入口）

**请求头**：`Content-Type: application/json`、`Accept: text/event-stream`。同源 fetch，靠第一方 Cookie 维持会话粘性；**前端不需要**带 `makers-conversation-id`，也不要显式设置 `credentials`。

**请求体**

| 字段 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `messages` | array | 是 | 1–60 条；每项 `{role:'user'\|'assistant', content:string}`；content 非空字符串；单条截 8000 字；累计 ≤60000 字 |
| `systemPrompt` | string | 否 | 项目级系统指令；trim 后 ≤4000 字；仅「启用且非空」时携带 |

```jsonc
// A. 停用系统指令 / 老客户端（字段完全不存在）
{ "messages": [{"role":"user","content":"你好"}] }

// B. 启用系统指令
{
  "messages": [{"role":"user","content":"帮我写段代码"}],
  "systemPrompt": "你是资深全栈工程师，先给结论再给可运行代码…"
}
```

**`systemPrompt` 校验规则【事实，线上实测】**

| 输入 | 行为 |
|---|---|
| 缺失 / `null` / 非 string | 静默按「未提供」处理，只发 1 条 system，不报错 |
| 空串 / 纯空白 | 同上 |
| 有效内容 | 取 trim 后字符串；长度按 trim 后计 |
| 正好 4000 字 | 通过 |
| 4001 字 | HTTP 400 `{"error":"systemPrompt 长度不能超过 4000 字，请精简后重试"}`，零上游调用 |
| 纯空白 `content` | HTTP 400（前后端均已过滤） |

**成功响应**：`200`，`text/event-stream; charset=utf-8`

```
data: {"delta":"你"}\n\n
data: {"delta":"好"}\n\n
data: {"delta":""}\n\n        ← 每 5 秒一次的心跳帧，零长度 delta，前端跳过但重置超时计时
data: {"error":"AI 网关返回 HTTP 429"}\n\n   ← 流内错误，之后仍会发 [DONE]
data: [DONE]\n\n
```

**响应头**：`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache, no-transform`、`Connection: keep-alive`、`X-Accel-Buffering: no`、`Access-Control-Allow-Origin: *`。

**前端 delta 兼容字段**：`delta` / `delta.content` / `delta.text` / `content` / `text` / `answer` / `response` / `message` / `choices[0].delta.content` 等。

**错误码**

| 状态 | 含义 |
|---|---|
| 400 | 参数校验失败（含 systemPrompt 超长），JSON 体 `{"error":"..."}` |
| 405 | 非 POST 方法 |
| 204 | OPTIONS 预检 |
| 502 | 回环与直连两条路径均不可用，JSON 体含明确诊断（如缺失变量名 / 回环首字节超过 12s） |

**超时链**：回环首字节 12s（超时即降级）→ Agent 侧空闲 45s / 硬超时 100s → Cloud Function 墙钟 120s → 前端 120s 无新数据兜底。客户端 `AbortController` 会逐级 abort 上游。

**其他**：响应可能带 `Set-Cookie: eo_conversation_id=<UUID>; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`，仅随机 UUID、不含密钥。`systemPrompt` 不回显到 SSE 帧、错误体或日志。

### 4.2 `POST /chat`（内部 Agent 端点）

由 `agents/chat/index.ts` 自动注册。请求体与 `/api/chat` 相同，入口 `onRequest(context)` 用 `validateAndNormalize` 做前置校验（同样拦 4000 字超长）。一般供 `/api/chat` 回环调用，也可单独联调。**注意**：平台约定 `context.request.body` 已预解析、headers 是普通对象（不用 `.get()`）、环境变量只能从 `context.env` 读取。

### 4.3 环境变量

| 变量 | 来源 | 当前值 |
|---|---|---|
| `AI_GATEWAY_API_KEY` | CLI 依据 `.env.example` 自动注入 | 生产 + 预览 |
| `AI_GATEWAY_BASE_URL` | 同上 | `https://ai-gateway.edgeone.link/v1`（生产 + 预览） |
| `AI_GATEWAY_MODEL` | 需手动 `env set` | `@makers/deepseek-v4.1-flash`（仅生产环境） |

代码里 `agents/_model.ts:10` 与 `cloud-functions/api/chat.js:47` 的 `DEFAULT_MODEL` 也是同一模型，构成双保险：即使某运行时拿不到环境变量也不会回退到旧模型。

> 铁律：`agents/` 与 `cloud-functions/` 内**禁止** `process.env` / `os.environ`，一律 `context.env`；`.env.example` 必须保留在仓库中，否则部署时不会自动注入网关变量。

### 4.4 可用模型（供后续扩展参考）

**【事实】** 2026-11-09 用本项目凭证逐个实测，以下 8 个 `chat/completions` 可用：
`@makers/hy3`、`@makers/hy3-preview`、`@makers/deepseek-v4-pro`、`@makers/deepseek-v4-flash`、`@makers/deepseek-v4.1-flash`、`@makers/minimax-m3`、`@makers/minimax-m2.7`、`@makers/kimi-k2.6`。

**【事实】** 官方文档还列了 `@makers/zhuque-text`，但实测 400，提示必须走 `/v1/providers/zhuque-text/classify`——是分类接口，**不能用于聊天**。网关不开放 `/v1/models`（404），无法枚举。

**【文档】** 厂商模型（需先在控制台绑定自己的 BYOK Key）格式为 `provider/model`，支持 OpenAI / Anthropic / Google AI Studio / DeepSeek / MiniMax / Hunyuan / Zhipu / Moonshot。未绑定时返回 400 `No active BYOK key configured for provider ...`。

---

## 5. 前端数据结构与关键实现

**持久化**：`localStorage['cyberchat.v1']`

```jsonc
{
  "version": 1,
  "activeProjectId": "p-xxx",
  "projects": [{
    "id": "p-xxx", "name": "默认项目",
    "createdAt": 0, "updatedAt": 0,
    "systemPrompt": { "enabled": false, "text": "", "presetId": null },
    "activeSessionId": "s-xxx",
    "sessions": [{
      "id": "s-xxx", "title": "新会话",
      "createdAt": 0, "updatedAt": 0,
      "messages": [
        { "role": "user", "content": "...", "ts": 0 },
        { "role": "assistant", "content": "...", "ts": 0, "stopped": false }
      ]
    }]
  }]
}
```

- `normalizeState()` 对坏 JSON、非法结构、非法 role、重复 id、失效 session、版本不符全部收敛或就地迁移；上限 50 项目 / 每项目 100 会话 / 每会话 200 条。
- `localStorage` 被禁用或抛 `SecurityError` / `QuotaExceeded` 时静默降级为内存态，侧栏显示「存储不可用 · 仅本次有效」。
- **世代机制**：每次切换项目/会话 `generation+1` 并 abort 在途请求；所有增量经 `deliverDelta()` 双重校验，旧请求的增量不会回写进新会话，已生成的部分只留在旧会话并标 `stopped`。
- 关键位置：`app.js:24` `CHAT_API`、`:25` `STORAGE_KEY`、`:281` `buildRequestBody()`、`:1209` `fetch`。
- 历史裁剪：≤40 条 / ≤50000 字符 / 单条 ≤8000 / 保证首条为 user（对后端 60/60000/8000 留余量）。
- **XSS 铁律**：用户与助手文本一律 `textContent` / `Text` 节点；`innerHTML` 仅用于硬编码静态 SVG。轻量 Markdown（代码块 + 复制按钮）自建 DOM 节点，零依赖。

---

## 6. 本地开发与部署

**前置**：Node 20+、EdgeOne CLI ≥ 1.6.7（本机 1.6.47）、已登录腾讯云账号。所有 `edgeone` 命令前置 `export PAGES_SOURCE=skills`。

```bash
cd ai-chat-assistant
export PAGES_SOURCE=skills

edgeone -v                 # 版本自检
edgeone whoami             # 登录态自检（exit 1 表示未登录）
edgeone makers env ls      # 查看项目环境变量（注意：会明文打印 API Key）

# 本地预览（非交互，两个 flag 都不能省）
edgeone makers dev --name ai-chat-assistant --skip-env-sync
# 打开 http://127.0.0.1:8088/   （必须用 127.0.0.1，不要用 localhost）

# 部署（项目已 link，前台同步执行）
edgeone makers deploy --json
```

**CLI 参数【文档，来自 `--help`，1.6.47】**

| 命令 | 参数 |
|---|---|
| `link` | `-n/--name <项目名>`（跳过交互）、`-t/--token`、`-a/--area global\|overseas` |
| `dev` | `-n/--name`、`--skip-env-sync`、`--skip-ai-gateway-sync`、`--port`、`--debug` |
| `deploy [dirOrZip]` | `-n/--name`、`-t/--token`、`-e/--env production\|preview`、`-a/--area`、`--json`、`--skip-ai-gateway-sync`、`--anonymous` |
| `env` | `pull` / `ls` / `set` / `rm` |

**沙箱 / CI 注意【事实】**
- 交互式 prompt 会卡死进程：dev 必须带 `--skip-env-sync`，link 带 `-n`，deploy 带 `--json`。
- 已登录时 deploy/dev 不需要 `-t`；CI 里用 `-t <token>` 或 `EDGEONE_PAGES_API_TOKEN`。
- 沙箱内 curl 测本地服务需加 `--noproxy '*'`，否则 SSE 被代理吞掉。
- 带鉴权参数的完整访问地址每次部署都会重新生成，**必须原样使用 CLI 输出的 `url`**（去掉 `?eo_token=...` 会 401）；也不要把它写进仓库或文档。
- `edgeone makers dev` 与 `deploy` 都会写 `.edgeone/`，**不要同时运行**；部署前先停 dev server。
- 静态资源由 CLI 从项目根目录复制到 `.edgeone/assets`（每次重新复制，旧快照无需手工清理）。

**线上验证示例**（先换鉴权 Cookie，再测接口）：
```bash
BASE="https://<deploy-url-host>"; Q='<完整 eo_token / eo_time 查询串>'
curl -sS -L -c /tmp/cj.txt -b /tmp/cj.txt -o /dev/null -w "%{http_code}\n" "$BASE/?$Q"
curl -sS -N -b /tmp/cj.txt -X POST "$BASE/api/chat" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"只回复两个字：在线"}]}'
```

---

## 7. 目前进度

### 时间线【事实】

| 时间 | 阶段 | 交付 | Deployment ID |
|---|---|---|---|
| 2026-11-09 上午 | 初版上线 | 纯静态前端 + 平台 Agent + SSE `/api/chat`，模型 `@makers/deepseek-v4-flash` | `dpe5mnuge42s` |
| 2026-11-09 14:2x | 模型切换 | 改为 `@makers/deepseek-v4.1-flash`（代码默认值 + 生产环境变量双保险） | `dpd7oxngvn83` |
| 2026-11-09 16:xx | 赛博朋克重做 | 项目管理 + 系统指令模式 + 霓虹视觉 + Markdown | `dp91hb9ypd7d` |
| 2026-11-09 17:2x | 最终部署 | 前后端合并上线，线上 6 项验证全通过 | `dp91hb9ypd7d` |

### 已完成

- 前端：项目/会话 CRUD、localStorage 持久化与异常兜底、系统指令开关 + 4 个中文预设 + 4000 字校验、赛博朋克霓虹动效（含 `prefers-reduced-motion` 与小屏抽屉）、轻量 Markdown、SSE 流式解析器、停止生成、错误重试、XSS 防护。
- 后端：可选 `systemPrompt` 契约、双路径推理与自动降级、心跳与超时链、CORS、会话 Cookie、输入校验。
- 验证：前端离线自测 132 项、后端函数级 mock 102 项全通过；线上实测首页为新版（`app.js` 69198B / `style.css` 47973B 与本地一致）、不带/带 `systemPrompt` 均正常、4001 字返回 400。
- 部署链路：CLI 安装、中国站登录、link、env 注入、静态 + Node Functions + Agent 构建均跑通。

### 待办 / 已知限制【事实】

| 项 | 现状 | 影响 |
|---|---|---|
| 无用户账号体系 / 服务端存储 | 数据只在浏览器 localStorage | 换设备或清缓存即丢失，不能多端同步 |
| 无自动化测试文件入库 | 成员自测脚本写在 `/tmp`，未随仓库保存 | 接手后无法直接 `npm test`，建议补 Vitest + mock fetch |
| 内置模型合规 | 官方明确「仅用于早期技术验证、不保证输出质量、不要用于生产环境」 | 若要面向真实用户/商用，需绑定厂商 Key 走 BYOK |
| `edgeone.json` deprecated | `cloudFunctions.nodejs.includeFiles` 被 CLI 提示将移除 | 构建仍成功，建议后续迁移为 `cloudFunctions.includeFiles` |
| SSE 不回传模型标识 | 响应只有 delta / error / DONE | 无法从响应直接确认实际调用的模型，建议在响应头加 `X-AI-Model` |
| 无 `/stop` 端点 | 停止生成靠前端 AbortController | 目前可用；若做服务端会话持久化则需补 |
| 文档会被静态部署 | `TECHNICAL_DOC.md` 在项目根目录 | 公网可读，故不含任何凭据 |
| 项目尚无 git 仓库 | 本机 `gh` 已登录 `KARASzz` | 见第 8 节 |

---

## 8. 连接 GitHub 仓库（给 Codex 接管用）

**当前状态【事实】**：`ai-chat-assistant/` 下**没有 `.git`**；本机 `gh` 2.98.0 已登录 GitHub 账号 `KARASzz`（https 协议，token 具备 `repo` / `workflow` 权限）。`.gitignore` 已覆盖 `.env`、`.env.*`（放行 `.env.example`）、`.edgeone/*`、`.tef_dist/*`、`node_modules/`、编辑器与密钥文件。

### 8.1 首次初始化并推送

```bash
cd "/Users/karas/+Python mac/WorkBuddy/2026-11-09-11-28-06/ai-chat-assistant"

git init -b main
git status --short                 # 确认清单里没有 .env / .edgeone/ / .env.local
git check-ignore -v .env .edgeone/auth.json    # 应显示命中规则

git add .
git commit -m "feat: NEON//CHAT cyberpunk AI assistant on EdgeOne Makers"

# 一步建私有仓库 + 关联 + 推送（推荐私有，避免架构细节与配置外泄）
gh repo create ai-chat-assistant --private --source=. --remote=origin --push

# 若仓库已在 GitHub 上创建，改用手动关联：
# git remote add origin https://github.com/KARASzz/ai-chat-assistant.git
# git push -u origin main
```

### 8.2 推送前安全检查（务必逐项确认）

| 绝不能入库 | 原因 |
|---|---|
| `.env` | 含明文 `AI_GATEWAY_API_KEY` |
| `.edgeone/auth.json` | 腾讯云登录凭证 |
| `.edgeone/project.json`、`.edgeone/assets/` | 本地构建产物 / link 状态 |
| 任何带 `eo_token` / `eo_time` 的完整访问链接 | 访问鉴权参数 |
| `*.pem` / `*.key` / 自行复制的 token 文件 | 凭据 |

`.env.example` **必须入库**（只有空占位，无密钥）——CLI 靠它判断要自动注入哪些变量。

### 8.3 Codex 侧接手步骤【建议，未在全新环境实测】

1. `git clone <repo>` 后 `cd ai-chat-assistant`。
2. `npm install`（零依赖，可跳过但建议跑一次以生成 lockfile 一致性）。
3. `edgeone login --site china --local` —— 需同一个腾讯云账号；`--local` 把凭证写进项目内 `.edgeone/auth.json`，沙箱里更可靠。
4. `edgeone makers link -n ai-chat-assistant` —— clone 后没有 `.edgeone/project.json`，必须重新 link 才能拿到远端环境变量与平台能力。
5. `export PAGES_SOURCE=skills` 后 `edgeone makers dev --name ai-chat-assistant --skip-env-sync`，打开 `http://127.0.0.1:8088/`。
6. 若接口报「未注入 AI_GATEWAY_*」，用 `edgeone makers env ls` / `edgeone makers env pull` 复核，或去掉 `--skip-env-sync` 让它同步远端 env。
7. 部署：`edgeone makers deploy --json`；CI 场景改用 `-t <token>` 或 `EDGEONE_PAGES_API_TOKEN`，并保留 `--json` 以便解析结果。

**CI 自动部署【建议】**：可用 GitHub Actions 在 push 到 main 时执行 `edgeone makers deploy -t "$EDGEONE_PAGES_API_TOKEN" --json`，token 存为仓库 Secret。此路径尚未在本项目验证，需自行跑通后再启用。

---

## 9. 来源与口径区分

| 内容 | 性质 | 来源 |
|---|---|---|
| 内置模型清单、生产环境警告、`@makers/` 前缀规则、BYOK 厂商列表 | 平台官方口径 | https://edgeone.ai/document/211330463446065152 |
| Makers Models 统一网关 / 多 SDK 兼容 | 平台官方口径 | https://pages.edgeone.ai/document/models |
| 「8+ 模型供应商」「50 万免费 tokens」「零平台费」 | **平台宣传口径**，未独立核实 | https://pages.edgeone.ai/use-cases/ai-agent-gateway |
| 厂商模型 ID 格式 `provider/model`、需绑定 BYOK Key | 平台官方口径 | https://edgeone.ai/document/211331008216948736 |
| CLI 参数、非交互 flag、路由规则 | 本机 1.6.47 `--help` 与专家包 `makers-agents` / `makers-cloud-functions` 文档 | 本地实测 |
| 8 个模型可用、`zhuque-text` 为分类接口、`/v1/models` 404 | **本项目账号实测**（2026-11-09） | 见第 4.4 节 |
| 接口响应、错误码、部署与验证结果 | **生产环境实测** | 见第 4 / 7 节 |

> 平台宣传口径（免费额度、节点数、加速能力等）不在本文档做事实性断言；涉及商用决策时请自行到控制台复核当前额度与条款。
