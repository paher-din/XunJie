import { defineConfig, devices } from '@playwright/test'
import { PREP_URL, REAL_URL, PREP_PORT, REAL_PORT } from './e2e/env'

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
  // 只并行独立 spec；文件内顺序保留，避免重启 strictPort / 系统剪贴板争用。
  // 每项仍由 Playwright 建新 context，写场景另用 UUID 隔离 fixture authority。
  fullyParallel: false,
  workers: 2,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
  projects: [{
    name: 'chromium',
    // 默认用 Playwright 自带的 Chromium，保证任何人 `npm run test:e2e` 都能复现同一道门禁。
    // 验收要在**真实 Chrome** 上取证时设 XUNJIE_E2E_BROWSER_CHANNEL=chrome（本机安装的 Google Chrome），
    // 只换浏览器实现，不换用例、不换断言。设备档位的 UA 固定为 Windows；在 macOS 上沿用会让
    // Chrome 以 Windows 输入路径处理隐藏 textarea，重复插入正文，所以保留本机真实 UA。
    use: { ...devices['Desktop Chrome'], ...(process.env.XUNJIE_E2E_BROWSER_CHANNEL
      ? { channel: process.env.XUNJIE_E2E_BROWSER_CHANNEL, userAgent: undefined }
      : {}) },
  }],
  // xj-dev 验收（xjDevBaseline.spec.ts）直连运行中的环境，不需要也不应拉起 prep/real 服务。
  webServer: process.env.XUNJIE_XJ_DEV_URL ? [] : [
    {
      command: `npm run dev:prep -- --port ${PREP_PORT}`,
      env: { XUNJIE_VITE_CACHE_DIR: `.playwright/node_modules/.vite-prep-${PREP_PORT}` },
      url: PREP_URL,
      // 本机常已有一个 dev:prep 在跑（端口 strictPort，再起会直接失败），所以本地复用；
      // CI 一律新起进程——fixture authority 是进程级状态，复用陈旧进程会让断言失去意义。
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: `npm run dev -- --port ${REAL_PORT} --strictPort`,
      env: { XUNJIE_VITE_CACHE_DIR: `.playwright/node_modules/.vite-real-${REAL_PORT}` },
      url: REAL_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
})
