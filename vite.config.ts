import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import netlify from '@netlify/vite-plugin-tanstack-start'

const config = defineConfig({
  plugins: [
    devtools(),
    netlify(),
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    tanstackStart({
      router: {
        // Co-located HTTP tests live beside the routes they exercise
        // (src/routes/api/v1/*.integration.test.ts). Without this the
        // generator warns "does not export a Route" for each of them on
        // every dev start and build.
        routeFileIgnorePattern: '\\.test\\.tsx?$',
      },
    }),
    viteReact({
      babel: {
        plugins: ['babel-plugin-react-compiler'],
      },
    }),
  ],
})

export default config
