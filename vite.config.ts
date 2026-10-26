import { defineConfig, normalizePath } from 'vite';
import react from '@vitejs/plugin-react';
import { build } from 'esbuild';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';

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

// Stamp each build's identity into index.html for the page and the server to
// read alike. Output names carry content hashes, so the same code yields the
// same identity and any change to it yields a new one. Dev gets none.
const buildIdentity = {
  name: 'build-identity',
  apply: 'build' as const,
  transformIndexHtml: {
    order: 'post' as const,
    handler(_html: string, context: import('vite').IndexHtmlTransformContext) {
      const names = Object.keys(context.bundle ?? {}).sort().join('\n');
      const build = createHash('sha256').update(names).digest('hex').slice(0, 16);
      return [{ tag: 'meta', attrs: { name: 'bespingle-build', content: build }, injectTo: 'head' as const }];
    },
  },
};

export default defineConfig({
  plugins: [cameraWorkerDev, react(), buildIdentity],
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
