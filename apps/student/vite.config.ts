import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { i0PrepFixture } from './prep/plugin'

/**
 * `--mode prep` 且是开发进程时才挂 I0-A 准备 fixture；
 * `vite build` 与 `vite preview` 都不加载它，正式产物因此不含准备端点与合成材料。
 */
export default defineConfig(({ command, mode }) => ({
  plugins: [react(), ...(mode === 'prep' && command === 'serve' ? [i0PrepFixture()] : [])],
  server: {
    host: '127.0.0.1',
    port: 5180,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.js'],
  },
}))
