-- =========================================================================
-- CYBER//LAB 赛博实验室核心业务表 (Cloud SQL PostgreSQL 18 - 数据库: postgres)
-- 与已有 wiki_pages 表同库，实现数据持久化与知识沉淀双向打通
-- =========================================================================

-- 1. 项目表：存储实验项目及其专属协议配置
CREATE TABLE IF NOT EXISTS lab_projects (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    system_prompt JSONB DEFAULT '{"enabled": false, "text": "", "presetId": null}'::JSONB,
    active_session_id VARCHAR(64),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lab_projects_updated_at ON lab_projects(updated_at DESC);

-- 2. 实验会话与对话消息表：存储多轮问答流与遥测快照
CREATE TABLE IF NOT EXISTS lab_sessions (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES lab_projects(id) ON DELETE CASCADE,
    title VARCHAR(128) NOT NULL,
    messages JSONB DEFAULT '[]'::JSONB,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lab_sessions_project ON lab_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_lab_sessions_updated_at ON lab_sessions(updated_at DESC);

-- 3. 实验沉淀与标签笔记表（含 Wiki 关联）
CREATE TABLE IF NOT EXISTS lab_annotations (
    session_id VARCHAR(64) PRIMARY KEY REFERENCES lab_sessions(id) ON DELETE CASCADE,
    tags JSONB DEFAULT '[]'::JSONB,
    notes TEXT DEFAULT '',
    runs JSONB DEFAULT '{}'::JSONB,
    wiki_path VARCHAR(256),             -- 关联已沉淀的 wiki_pages.path
    wiki_synced_at TIMESTAMP WITH TIME ZONE,
    updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lab_annotations_wiki ON lab_annotations(wiki_path);

-- 4. 权限授予 (允许 Cloud Run 运行身份访问)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cyber-lab-runtime@karas-513205.iam') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON lab_projects TO "cyber-lab-runtime@karas-513205.iam";
        GRANT SELECT, INSERT, UPDATE, DELETE ON lab_sessions TO "cyber-lab-runtime@karas-513205.iam";
        GRANT SELECT, INSERT, UPDATE, DELETE ON lab_annotations TO "cyber-lab-runtime@karas-513205.iam";
        GRANT SELECT, INSERT, UPDATE ON wiki_pages TO "cyber-lab-runtime@karas-513205.iam";
    END IF;
END $$;
