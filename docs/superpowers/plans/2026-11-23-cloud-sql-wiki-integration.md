# Cloud SQL 数据持久化与私人 Wiki 打通实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 CYBER//LAB 赛博实验室的实验与对话数据迁移并持久化至 Cloud SQL (`postgres` 库)，并在观测台支持一键沉淀结构化知识到私人 Wiki (`wiki_pages` 表)，完成测试与 git 提交推送。

**Architecture:** 采用 Local-first 混合架构：前端即时读写 localStorage 保证毫秒级响应，后台防抖向 `/api/lab/sync` 提交增量，页面启动通过 `/api/lab/workspace` 拉取最新状态；后端 `cloudrun/server.mjs` 直连同实例的 `postgres` 库处理 `lab_*` 表的 CRUD，并通过 `/api/lab/promote-to-wiki` 格式化后直接写入 `wiki_pages`。

**Tech Stack:** Node.js (ES modules), PostgreSQL 18 (pg, @google-cloud/cloud-sql-connector), Vanilla JS, Playwright.

---

### Task 1: 编写 Cloud SQL DDL 与数据库迁移配置

**Files:**
- Create: `scripts/cloudsql_schema.sql`
- Modify: `cloud_run_ops_workbench.py:28-32`

- [ ] **Step 1: 创建 DDL 脚本**

编写 `scripts/cloudsql_schema.sql`，定义 `lab_projects`、`lab_sessions`、`lab_annotations` 三张表及其索引与外键级联。

- [ ] **Step 2: 更新 `cloud_run_ops_workbench.py` 的数据库目标**

将 `cloud_run_ops_workbench.py` 中的 `DATABASE = 'cyber_lab'` 调整为 `DATABASE = 'postgres'`，并在 `ALLOWED_EXACT_PATHS` 中加入 `scripts/cloudsql_schema.sql`。

- [ ] **Step 3: 运行静态检查验证**

运行：`node -c cloud_run_ops_workbench.py || python3 -m py_compile cloud_run_ops_workbench.py`
预期：PASS

- [ ] **Step 4: 提交代码**

```bash
git add scripts/cloudsql_schema.sql cloud_run_ops_workbench.py
git commit -m "feat(db): 添加 Cloud SQL 数据表 DDL 与运维配置更新"
```

---

### Task 2: 后端实现 `/api/lab/workspace`、`/api/lab/sync` 与 `/api/lab/promote-to-wiki`

**Files:**
- Modify: `cloudrun/server.mjs`

- [ ] **Step 1: 编写后端数据库操作与路由处理**

在 `cloudrun/server.mjs` 中增加：
1. `GET /api/lab/workspace`：读取 `lab_projects`、`lab_sessions` 和 `lab_annotations`，组装全量工作区 JSON 返回。
2. `POST /api/lab/sync`：事务内批量 UPSERT 项目、实验会话及标签笔记。
3. `POST /api/lab/promote-to-wiki`：提取指定实验的笔记和对话摘要，生成满足 Wiki Frontmatter 与内容规范的 Markdown，写入 `wiki_pages` 表，更新 `lab_annotations.wiki_path`。

- [ ] **Step 2: 编写针对 `/api/lab/*` 接口的单元测试**

在 `tests/unit/lab-cloudsql.test.mjs` 中针对 mock 数据库池验证 `/api/lab/workspace`、`/api/lab/sync` 和 `/api/lab/promote-to-wiki` 的参数校验、返回结构与 SQL 拼接。

- [ ] **Step 3: 运行单元测试**

运行：`node tests/unit/lab-cloudsql.test.mjs`
预期：PASS

- [ ] **Step 4: 提交代码**

```bash
git add cloudrun/server.mjs tests/unit/lab-cloudsql.test.mjs
git commit -m "feat(api): 实现工作区云端拉取、增量同步与 Wiki 沉淀接口"
```

---

### Task 3: 前端数据层扩展：云端拉取与自动同步

**Files:**
- Modify: `scripts/core/lab-data.js`
- Modify: `scripts/core/state.js`
- Modify: `app.js`

- [ ] **Step 1: 编写云端同步方法**

在 `scripts/core/lab-data.js` 中增加 `fetchCloudWorkspace()`、`syncToCloud(workspace, annotations)` 和 `promoteSessionToWiki({ sessionId, title, category, tags })`。

- [ ] **Step 2: 在 `app.js` 中集成启动拉取与防抖同步**

页面启动时调用 `fetchCloudWorkspace()`（本地为空时拉取填充）；在项目/会话/消息/笔记发生实质修改后，防抖 2 秒触发 `syncToCloud`，在顶栏或观测台更新同步状态指示。

- [ ] **Step 3: 运行现有单元测试**

运行：`npm run check`
预期：PASS

- [ ] **Step 4: 提交代码**

```bash
git add scripts/core/lab-data.js scripts/core/state.js app.js
git commit -m "feat(ui): 前端集成云端工作区拉取与防抖同步"
```

---

### Task 4: 前端观测台界面：增加【沉淀至私人 Wiki】弹窗与按钮

**Files:**
- Modify: `index.html`
- Modify: `styles/lab.css`
- Modify: `app.js`

- [ ] **Step 1: 在 `index.html` 观测台中增加 Wiki 操作区与弹窗**

在 `#sys-panel` 观测台的“标签与实验结论”模块下方增加 `<button id="lab-promote-wiki-btn">沉淀至私人 Wiki</button>`，并添加 `<dialog id="lab-promote-wiki-dialog">` 模态弹窗（包含标题输入、分类下拉、标签确认）。

- [ ] **Step 2: 在 `app.js` 中绑定弹窗事件与提交逻辑**

打开弹窗时自动预填当前实验标题、笔记提取与标签；点击确认后调用 `promoteSessionToWiki`，成功后在界面展示“已沉淀至 Wiki: `[[path]]`”并更新标注状态。

- [ ] **Step 3: 运行完整检查**

运行：`npm run check`
预期：PASS

- [ ] **Step 4: 提交代码**

```bash
git add index.html styles/lab.css app.js
git commit -m "feat(ui): 观测台支持一键沉淀实验至私人 Wiki"
```

---

### Task 5: 真实 Cloud SQL 数据库应用与全量回归测试

**Files:**
- Modify: `scripts/build-static.mjs` (若有新增静态资源需列入白名单)
- Modify: `TECHNICAL_DOC.md`

- [ ] **Step 1: 将 DDL 应用至 Cloud SQL `postgres` 数据库**

通过 gcloud 或 psql 执行 `scripts/cloudsql_schema.sql`，并为 `cyber-lab-runtime@karas-513205.iam` 赋予权限。

- [ ] **Step 2: 运行全量静态检查与 E2E 测试**

运行：`npm run check && npm run test:e2e`
预期：PASS

- [ ] **Step 3: 更新技术文档**

更新 `TECHNICAL_DOC.md`，记录 Cloud SQL `postgres` 数据库持久化及私人 Wiki 打通细节。

- [ ] **Step 4: 提交代码并推送远程 Git**

```bash
git add -A
git commit -m "chore: 完成 Cloud SQL 持久化与 Wiki 互通，更新技术文档"
git push origin main
```
