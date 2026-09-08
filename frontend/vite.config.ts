import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH || (process.env.NODE_ENV === 'production' ? '/dashboard/' : '/dashboard-dev/'),
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    watch: {
      usePolling: true
    },
    proxy: {
      '/api/dev': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: true,
      },
      '/socket.io': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: true,
        ws: true,
      },
    },
    allowedHosts: [
      'localhost',
      'localhost',
      '.example.com'
    ]
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true
  },
  build: {
    chunkSizeWarningLimit: 2200
  }
});
