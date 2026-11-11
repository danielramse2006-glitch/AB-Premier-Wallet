import { defineConfig } from 'vite';
export default defineConfig({base:'./',build:{rollupOptions:{input:{portal:'index.html',admin:'admin.html',walletPreview:'wallet-preview.html'}}}});
