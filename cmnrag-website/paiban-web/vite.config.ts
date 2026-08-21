import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/schedule/',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  build: {
    // 直接构建到主 Worker 的静态资源目录 public/schedule（被 ASSETS 托管，路径 /schedule/）
    outDir: '../public/schedule',
    emptyOutDir: true,
  },
});
