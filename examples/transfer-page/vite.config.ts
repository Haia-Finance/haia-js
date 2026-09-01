import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    // 5173 is not arbitrary: it is the origin control plane deployments allow
    // out of the box. On another port a local run hits a CORS preflight
    // failure rather than a policy decision.
    port: 5173,
    strictPort: true,
  },
})
