import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    // 5173 не случаен: он в дефолтном CORS-allowlist ingest-сервиса haia-cp
    // (`_DEFAULT_ORIGINS` в backend/src/infra/config.py). На другом порту
    // локальный прогон упрётся в preflight, а не в политику.
    port: 5173,
    strictPort: true,
  },
})
