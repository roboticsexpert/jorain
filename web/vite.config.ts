import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: process.env.VITE_MOCK === '1' ? undefined : {
      '/api': { target: process.env.VITE_API_TARGET ?? 'http://localhost:3141', changeOrigin: true },
    },
  },
});
