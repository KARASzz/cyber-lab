import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Playwright 配置。
 * - 所有 /api/chat 请求在测试内用 page.route mock，静态服务器不实现聊天接口。
 * - webServer 启动仅测试用的静态文件服务器（tests/support/static-server.mjs）。
 * - 提供桌面 chromium 与移动视口两个项目；accessibility/e2e 复用同一 baseURL。
 */
const PORT = Number(process.env.E2E_PORT || 8123);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: mkdtempSync(join(tmpdir(), 'cyber-lab-playwright-')),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: {
    command: `node tests/support/static-server.mjs ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
