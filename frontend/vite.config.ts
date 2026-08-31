import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: ['silpo.lysak.pp.ua'],
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://backend:3000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test-setup.ts'
  }
});
