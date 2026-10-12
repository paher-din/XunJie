import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { i0PrepFixture } from './prep/plugin'

/**
 * `--mode prep` 且是开发进程时才挂 I0-A 准备 fixture；
 * `vite build` 与 `vite preview` 都不加载它，正式产物因此不含准备端点与合成材料。
 */
export default defineConfig(({ command, mode }) => ({
  plugins: [react(), ...(mode === 'prep' && command === 'serve' ? [i0PrepFixture()] : [])],
  optimizeDeps: {
    // e2e 冷启动竞态（04A 首跑复现）：首轮优化完成后，懒加载路由再发现新依赖会触发整轮重优化，
    // 期间浏览器对旧优化产物拿到 504 Outdated Optimize Dep（trace: react-dom/@radix-ui）。
    // 把应用图里的裸依赖（含懒加载页面的 Dialog/marked/remend）全部预打进首轮，消除中途重优化。
    include: [
      'react',
      'react-dom/client',
      'react-router-dom',
      '@tanstack/react-query',
      '@radix-ui/react-dialog',
      'marked',
      'remend',
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 5180,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.js', 'prep/**/*.test.ts'],
  },
}))
