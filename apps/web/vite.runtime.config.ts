import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/',
  publicDir: false,
  plugins: [react(), {
    name: 'runtime-root-entry',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_, bundle) {
        const entry = bundle['runtime.html']
        if (!entry || entry.type !== 'asset') this.error('Runtime HTML entry is missing')
        delete bundle['runtime.html']
        entry.fileName = 'index.html'
        bundle['index.html'] = entry
      },
    },
  }],
  build: {
    outDir: 'dist-runtime',
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('./runtime.html', import.meta.url)) },
  },
})
