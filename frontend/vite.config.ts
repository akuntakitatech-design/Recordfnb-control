import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: /api diproksi ke backend lokal (default :8001, bisa diubah lewat VITE_DEV_API_TARGET).
// Produksi: Nginx (lihat nginx/default.conf.template) yang memproksi /api ke BACKEND_URL,
// sehingga frontend selalu memanggil path relatif /api tanpa URL absolut.
const devApiTarget = process.env.VITE_DEV_API_TARGET || 'http://localhost:8001';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
    proxy: { '/api': { target: devApiTarget, changeOrigin: false } },
  },
  build: { outDir: 'dist' },
});
