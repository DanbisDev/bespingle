import { defineConfig, normalizePath } from 'vite';
import react from '@vitejs/plugin-react';
import { build } from 'esbuild';
import { resolve, relative } from 'node:path';

// MediaPipe's WASM loader uses importScripts and requires a classic worker.
// Vite bundles classic workers for production; serve the same format in dev.
const cameraWorkerDev = {
  name: 'camera-worker-dev',
  configureServer(server: import('vite').ViteDevServer) {
    server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/src/cameraBackground.worker.ts?worker_file')) return next();
      try {
        const result = await build({
          entryPoints: [resolve(server.config.root, 'src/cameraBackground.worker.ts')], bundle: true, write: false, format: 'iife',
          plugins: [{ name: 'asset-urls', setup(builder) {
            builder.onResolve({ filter: /\?url$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'asset-url' }));
            builder.onLoad({ filter: /.*/, namespace: 'asset-url' }, (args) => ({ contents: `export default ${JSON.stringify('/' + normalizePath(relative(server.config.root, args.path)))}`, loader: 'js' }));
          } }],
        });
        res.setHeader('Content-Type', 'application/javascript');
        res.end(result.outputFiles[0].text);
      } catch (error) { next(error); }
    });
  },
};

export default defineConfig({
  plugins: [cameraWorkerDev, react()],
  server: {
    host: '127.0.0.1',
    port: 5555,
    strictPort: true,
    watch: { ignored: ['**/.cache/**', '**/test-results/**'] },
    proxy: {
      '/ws': { target: 'http://127.0.0.1:6666', ws: true },
      '/mcp': { target: 'http://127.0.0.1:6666' },
      '/api': { target: 'http://127.0.0.1:6666' },
    },
  },
});
