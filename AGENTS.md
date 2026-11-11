# Repository Guidelines

## 项目结构与职责

- `index.html`、`style.css`、`styles/lab.css` 和 `app.js` 是无框架的工作台页面、样式及交互入口；`scripts/core/` 与 `scripts/ui/` 提供数据、流协议、遥测和界面模块。
- `cloud-functions/api/chat.js` 提供 `POST /api/chat`，负责校验、流式响应及网关降级；`agents/chat/index.ts` 和 `agents/_*.ts` 实现 Agent 路由、模型配置及 SSE 辅助逻辑。
- `edgeone.json` 配置 EdgeOne Makers；`.env.example` 声明网关环境变量。`edgeone-makers-experts/` 是随仓库保存的平台专家资料，不属于页面源码。
- `TECHNICAL_DOC.md` 记录架构和接口约定；`tests/unit/`、`tests/contract/` 和 `tests/e2e/` 分别覆盖纯函数、双路径契约与浏览器工作流。

## 构建与本地开发

要求 Node.js 20+ 和 EdgeOne CLI。执行 CLI 命令前设置 `export PAGES_SOURCE=skills`。

- `npm ci`：安装锁定的开发依赖；前端没有运行时 npm 依赖。
- `npm run check`：执行语法、TypeScript、单元/契约测试与补丁空白检查。
- `npx playwright install chromium` 后执行 `npm run test:e2e`：运行桌面与移动浏览器回归，网关使用 mock。
- `npm run build`：运行静态前端的占位构建脚本；它不执行测试或打包。
- `edgeone makers dev --name ai-chat-assistant --skip-env-sync`：启动本地预览；按需打开 `http://127.0.0.1:8088/`。聊天功能还需要有效的网关配置。
- `git diff --check`：检查补丁中的空白问题。部署和本地预览都会写入 `.edgeone/`，不要同时运行。

## 编码与测试

遵循现有文件风格：JavaScript 和 TypeScript 使用两空格缩进、单引号、分号及 camelCase；沿用现有 HTML/CSS 的命名和格式。Agent 内部模块使用 `_` 前缀。当前未配置格式化器、linter 或覆盖率门槛；`npm run build` 不是功能测试。

修改后按影响范围验证：在浏览器检查页面及交互；修改聊天接口时检查输入校验、SSE 流和错误处理。新增自动化测试时，优先使用 `*.test.js` 或 `*.test.ts`，并在引入测试工具的同时提供可运行命令。

## 提交与安全

提交信息使用简洁中文，描述具体改动，例如 `修复聊天流式响应`。Pull request 应说明目的、主要变更和验证结果；关联相关 issue，涉及界面改动时附截图。

不要提交 `.env`、`.edgeone/`、密钥或带鉴权参数的访问链接；保留无真实密钥的 `.env.example`。后端运行时从 `context.env` 读取配置。`edgeone.json` 的输出目录为项目根目录，新增文件前须考虑其可能被作为静态资源发布。

## 开始任务前的检查

先读取相关源码和 `TECHNICAL_DOC.md`，再检查 `git status --short --branch`。技术文档记录的历史测试、登录及部署状态不是当前状态证明。保留用户已有修改，不覆盖、不顺手暂存，也不随自己的提交带走。默认中文沟通，交付说明实际修改、验证证据和剩余限制。

## 聊天架构与兼容性约束

浏览器调用同源 `/api/chat`；Cloud Function 优先代理 `/chat`，回环失败时降级为直连 AI Gateway。修改模型选择、校验、提示词或流协议时，必须同时检查 `agents/_chat.ts` 与 `cloud-functions/api/chat.js`，保持两条路径行为一致。

- `messages` 支持 1–60 条 `user`/`assistant` 消息；单条截断至 8000 字符，累计上限 60000 字符。校验与归一化顺序以源码为准。
- `systemPrompt` 只在前端启用且非空时发送；trim 后最多 4000 字符，4001 字符返回 HTTP 400，不调用模型。
- SSE 契约为 `data: {"delta":"..."}`、`data: {"error":"..."}` 和 `data: [DONE]`。空 delta 是心跳，不显示为内容。
- 不假定一次网络读取就是一条完整 SSE 帧。保留取消传播、超时、定时器清理和流关闭逻辑，避免重复回复或后台请求泄漏。
- 用户与助手文本通过 `textContent` 或 Text 节点写入；不要将不可信内容交给 `innerHTML`。
- 持久化使用 `localStorage['cyberchat.v1']`。数据结构变更须兼容旧数据和损坏数据；不得用清空用户存储代替迁移。

## CLI 发现与本地关联

先执行 `command -v edgeone`、`edgeone -v` 和 `PAGES_SOURCE=skills edgeone whoami`。当前 Mac 用户级入口为 `~/.local/bin/edgeone`，软链接指向 `/Users/karas/.workbuddy/binaries/node/versions/22.22.2-6/bin/edgeone`。WorkBuddy 升级可能改变版本目录；入口失效时检查目标，不要仅凭 PATH 查找失败就重新安装。

GitHub 仓库为 `KARASzz/cyber-lab`，Makers 项目名仍为 `ai-chat-assistant`。名称不同是正常状态，不据此创建新项目。新工作区没有 `.edgeone/project.json` 时，先检查 `edgeone makers link --help`，再关联已有项目；支持时使用 `--mode link_existing` 防止误建。`--skip-env-sync` 会保留本地环境文件，不会补齐缺失的网关配置。

## 按改动范围验收

| 改动范围 | 应验证的行为 |
| --- | --- |
| 文档、配置 | 空白检查、路径和命令正确性、部署影响 |
| 页面、样式 | 桌面与窄屏、键盘发送/换行、滚动、界面截图 |
| 项目与会话 | 新建、切换、刷新恢复、旧数据及损坏数据处理 |
| 聊天接口 | 正常多轮、指令开启/关闭、4000/4001 字符边界、非法输入 |
| 流与代理 | 分块、心跳、上游错误、停止生成、超时、降级及收尾 |

历史文档中的自测数量不能替代新修改的验证。新增自动化测试时使用 `tests/*.test.js` 或 `tests/*.test.ts`，同时补充运行脚本和必要依赖；优先验证可观察行为，常规回归 mock 网关，真实模型请求仅用于必要的集成验证。报告须区分“静态检查通过”“构建成功”和“线上功能实测通过”。

## 发布流程与静态资源边界

`main` 已配置生产自动部署，因此 push 可能直接发布线上版本；在用户授权范围内提交发布，并检查对应提交的部署结果。不要因控制台显示构建成功就宣称聊天可用。

手动部署前阅读 `edgeone-makers-experts/skills/makers-deploy/SKILL.md`，使用 `PAGES_SOURCE=skills edgeone makers deploy --json`，停止同目录的 dev 进程后再部署。核对 CLI 输出的项目与部署 ID，不手工生成平台内部配置。

`edgeone makers env ls` 可能明文输出密钥，不直接把其输出写入聊天或共享日志。`.gitignore` 不等于部署排除规则：当前输出目录为 `.`，根目录文档及资料可能公开。临时日志、备份和任何私密内容放在项目外；提交前检查暂存清单与忽略规则。

## 智能体执行与交付

简单任务由主线程完成，不为形式委派。需要委派时按用户规则显式指定 `gpt-6-luna`、推理强度 `max`，说明目标、必要输入、文件修改范围、预期输出、验收标准和依赖；子智能体不得再次委派，同一文件的修改串行协调。主线程检查差异与验证结果后交付，失败则返工。

普通主线程的目标设置为 `gpt-6.1-terra` / `high`；文字指令本身不会切换模型。区分目标设置、配置值与可信运行信息，未核实的内容明确标注，指定模型不可用时说明并确认替代方案。保留简明调度记录，不记录内部推理或凭证。

PR 描述应让未读过对话的维护者理解问题、最终行为、验证方法及风险；涉及数据结构、协议或环境变化时同步更新技术文档。不要把未完成的检查写成通过，也不要把历史线上结果冒充当前版本结果。
