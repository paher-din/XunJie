import { defineConfig, devices } from '@playwright/test'
import { PREP_URL, REAL_URL } from './e2e/env'

/**
 * I0-A 准备检查的最小浏览器 harness。
 *
 * 依据 docs/tasks/I0_UI_SPEC.md「Testing Decisions」与 docs/tasks/I0_UI_CLIENT_CONTRACT.md §2：
 * 测试启动**同一个可交互准备命令**（`npm run dev:prep`），在真实 Vite 页面上操作，
 * 断言可见正文、状态、对象归属与实际发出的请求；不在测试内另造一套假业务。
 *
 * 另起一个普通 `npm run dev`（真实模式）用于核对：fixture 不挂载、准备入口不出现、
 * 真实 `/api` 没有可回退的数据源（H-01 缺口如实暴露）。
 *
 * 端口固定且 strictPort：本机同时可能有设计仓库的 dev server（5180/5199/5290 等），
 * 端口漂移会让断言打到错误的进程上。
 */

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run dev:prep',
      url: PREP_URL,
      // 本机常已有一个 dev:prep 在跑（端口 strictPort，再起会直接失败），所以本地复用；
      // CI 一律新起进程——fixture authority 是进程级状态，复用陈旧进程会让断言失去意义。
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'npm run dev -- --port 5602 --strictPort',
      url: REAL_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
})
