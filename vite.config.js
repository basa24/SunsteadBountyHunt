import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        create: 'create.html',
        bounty: 'bounty.html',
        profile: 'profile.html',
      }
    }
  },
  server: {
    proxy: {
      '/xrpc': {
        target: 'https://tangled.org',
        changeOrigin: true,
        secure: true,
      },
      '/plc': {
        target: 'https://plc.directory',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/plc/, ''),
      }
    }
  }
});
