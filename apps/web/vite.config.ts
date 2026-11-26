import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import type { ProxyOptions } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import tsconfigPaths from 'vite-tsconfig-paths'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const envDir = fileURLToPath(new URL('../..', import.meta.url))

const config = defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, ['DALVA_', 'PORT'])
  const apiProxy: Record<string, ProxyOptions> = {
    '/api/': {
      target: env.DALVA_API_URL || `http://localhost:${env.PORT || '4000'}`,
      changeOrigin: false,
    },
  }

  return {
    envDir,
    server: { proxy: apiProxy },
    // The SPA build prerenders its shell through a preview server on `localhost`. In a container, the server
    // and Bun's fetch can resolve that to different families (::1 vs 127.0.0.1); a fixed IPv4 host avoids it.
    preview: { host: '127.0.0.1', proxy: apiProxy },
    plugins: [
      devtools(),
      tsconfigPaths({ projects: ['./tsconfig.json'] }),
      tailwindcss(),
      tanstackStart({
        spa: { enabled: true },
      }),
      viteReact(),
    ],
  }
})

export default config
