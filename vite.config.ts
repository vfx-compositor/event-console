/// <reference types="vitest" />
import { defineConfig } from 'vite';
// @ts-expect-error Build-only Node API; no Node types are required by the browser application.
import { readFileSync } from 'node:fs';

export default defineConfig({
  appType: 'mpa',
  // Relative asset URLs support local HTTP serving and subdirectory deployments.
  base: './',
  plugins: [{
    name: 'distribution-notices',
    generateBundle() {
      for (const fileName of ['LICENSE', 'THIRD_PARTY_NOTICES.md',
        'licenses/Pretendard-OFL-1.1.txt', 'licenses/Inter-OFL-1.1.txt', 'licenses/Barlow-OFL-1.1.txt']) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(new URL(fileName, import.meta.url), 'utf8') });
      }
    },
  }],
  build: {
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // 프로젝트 루트 기준 상대 경로 — node:path 없이 동작한다
      input: {
        index: 'index.html',
        control: 'control.html',
        display: 'display.html',
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
