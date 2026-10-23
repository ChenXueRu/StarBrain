import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  // 與後端共用專案根目錄的 .env
  const env = loadEnv(mode, '../..', '')

  return {
    plugins: [react()],
    // 3D 宇宙（three.js）是另外懶載入的一塊，約 1 MB 屬正常
    build: { chunkSizeWarningLimit: 1100 },
    server: {
      // 開發時把 /api 轉給後端
      proxy: {
        '/api': `http://127.0.0.1:${env.PORT || 3700}`,
      },
    },
  }
})
