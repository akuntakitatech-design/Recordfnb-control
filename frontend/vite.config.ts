import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: /api diproksi ke backend lokal (default :4100, override lewat VITE_DEV_API_TARGET).
// Produksi: Nginx memproksi /api ke container backend, sehingga frontend memakai path relatif.
const devApiTarget = process.env.VITE_DEV_API_TARGET || 'http://localhost:4100';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 4200,
    allowedHosts: true,
    proxy: { '/api': { target: devApiTarget, changeOrigin: false } },
  },
  build: { outDir: 'dist' },
});
