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
      },
      // tangled.org's appview is server-rendered HTML with NO CORS and no JSON
      // API. Issue open/closed state lives only there (not in any PDS record).
      // This dev-only proxy lets us read the issues pages to detect closed
      // issues. Not available in a static production build.
      '/tnglweb': {
        target: 'https://tangled.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/tnglweb/, ''),
      }
    }
  }
});
