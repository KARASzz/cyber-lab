# CYBER//LAB · 赛博实验室

一个无前端框架的本地实验工作台。浏览器保存项目、实验、对话和笔记；聊天通过同源 `/api/chat` 调用 EdgeOne Makers Agent，回环不可用时由 Cloud Function 降级到 AI Gateway。

## 功能

- 项目级实验协议、预设和多轮流式对话；支持停止、重试和安全的 Markdown 渲染。
- 每个实验可保存标签、结论笔记和观测结果；`⌘K` / `Ctrl+K` 打开命令与搜索。
- 导出单个实验的 Markdown，或下载包含工作区及笔记的 JSON 备份。导入前会预检，并以新 ID 合并，不覆盖同名项目。
- 展示实际收到的模型和路径响应头、首响应和首个非空增量耗时；缺失数据标记为“未提供”。这些指标不等同于模型内部 token 统计。

数据只保存在当前浏览器，不会自动跨设备同步。备份包含对话、协议及笔记，请妥善保管；导入文件上限为 5 MiB。导入遵守 50 个项目、每项目 100 个实验、每实验 200 条消息的容量上限。超过上限的旧数据仍会保留和完整导出，但无法直接导入；导出前会显示原因，请先整理数据或留存原始文件。

## 本地开发

要求 Node.js 20+ 与 EdgeOne CLI；正常运行没有前端运行时 npm 依赖。执行 EdgeOne 命令前设置 `PAGES_SOURCE=skills`。

```bash
npm ci
export PAGES_SOURCE=skills
edgeone makers dev --name ai-chat-assistant --skip-env-sync --skip-ai-gateway-sync
```

打开 `http://127.0.0.1:8088/`。上述参数不会自动拉取网关凭据；真实聊天需要运行时通过 `context.env` 提供有效的 `AI_GATEWAY_*` 配置。不要把 `.env`、`.edgeone/`、密钥或带鉴权参数的链接提交到仓库。

**本地预览的静态服务可能提供项目根目录下的文件，包括本地配置和开发依赖。** 不要把预览端口暴露给不可信网络；测试数据和截图应保存在项目目录之外。正式发布前应检查对应 CLI 版本的打包结果，不能把 `.gitignore` 当作部署排除规则。

## 检查与测试

```bash
npm run check                 # 语法、TypeScript、单元/接口测试和补丁空白检查
npx playwright install chromium
npm run test:e2e              # 桌面和移动浏览器；聊天网关使用 mock
npm run build                 # 仅输出提示，不打包或测试功能
```

单项命令为 `npm run test:unit`、`npm run test:contract`。Node 22.18+ 还可使用 `npm run test:native` 运行不依赖 tsx 的单元和接口测试。自动化测试使用合成数据与 mock；测试通过不代表真实网关或线上部署已验证。

更多数据结构、接口及验证边界见 [技术文档](TECHNICAL_DOC.md)。
