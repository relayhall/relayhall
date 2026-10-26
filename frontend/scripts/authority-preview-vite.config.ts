import { defineConfig } from 'vite';
import base from '../vite.config';
export default defineConfig({ ...base, define: { ...base.define, 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api') }, server: { ...base.server, host:'127.0.0.1',port:55441,
  proxy:{ '/api':{target:'http://127.0.0.1:55440',changeOrigin:true,rewrite:path=>path.replace(/^\/api/,'')} } } });
