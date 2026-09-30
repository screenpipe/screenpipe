// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: { include: ['eval-pipe-run-outputs.test.ts'], environment: 'node',
    pool: 'forks', poolOptions: { forks: { singleFork: true } } },
  resolve: { alias: { '@': path.resolve('.') } },
  css: { postcss: { plugins: [] } },
});
