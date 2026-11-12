import { defineConfig } from 'vite';

// Static site; relative base so it can be served from any sub-path (GitHub Pages).
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
