import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import type { ProxyOptions } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import tsconfigPaths from 'vite-tsconfig-paths'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The repo's only env file is the root .env.
const envDir = fileURLToPath(new URL('../..', import.meta.url))

const config = defineConfig(({ mode }) => {
  // apps/api (Better Auth at /api/auth, the API at /api/trpc). Web and API share one
  // origin, as behind the production proxy, so the session cookie is first-party.
  // DALVA_API_URL (shell or .env) wins; otherwise the API's PORT from .env, default 4000.
  const env = loadEnv(mode, envDir, ['DALVA_', 'PORT'])
  const apiProxy: Record<string, ProxyOptions> = {
    // Host and Origin stay the web origin: the API checks Origin against its PUBLIC_URL.
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
