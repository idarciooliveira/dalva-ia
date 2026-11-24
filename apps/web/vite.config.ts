import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import type { ProxyOptions } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import tsconfigPaths from 'vite-tsconfig-paths'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const config = defineConfig(({ mode }) => {
  // apps/api (Better Auth at /api/auth, contract routes at /api/v1). Web and API share one
  // origin, as behind the production proxy, so the session cookie is first-party.
  // DALVA_API_URL comes from the shell or apps/web/.env*; otherwise the PORT in apps/api/.env*.
  const env = loadEnv(mode, process.cwd(), 'DALVA_')
  const apiPort = loadEnv(mode, fileURLToPath(new URL('../api', import.meta.url)), '').PORT || '4000'
  const apiProxy: Record<string, ProxyOptions> = {
    // Host and Origin stay the web origin: the API checks Origin against its PUBLIC_URL.
    '/api/': {
      target: process.env.DALVA_API_URL || env.DALVA_API_URL || `http://localhost:${apiPort}`,
      changeOrigin: false,
    },
  }

  return {
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
