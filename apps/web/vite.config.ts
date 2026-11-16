import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import tsconfigPaths from 'vite-tsconfig-paths'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const backendDir = fileURLToPath(new URL('../../packages/backend', import.meta.url))

const config = defineConfig(({ mode }) => {
  // `convex dev` writes VITE_CONVEX_URL and VITE_CONVEX_SITE_URL to packages/backend/.env.local.
  // Use them unless the shell or apps/web/.env* already set a non-empty value.
  const web = loadEnv(mode, process.cwd(), 'VITE_')
  for (const [key, value] of Object.entries(loadEnv(mode, backendDir, 'VITE_'))) {
    if (!process.env[key] && !web[key]) process.env[key] = value
  }

  return {
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
