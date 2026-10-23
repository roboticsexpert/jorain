#!/usr/bin/env node
// `brain` CLI launcher: runs the TypeScript sources directly (Node 25 strips types natively), so the CLI
// never lags behind the code; falls back to the compiled build when src/ is absent.
import { existsSync } from 'node:fs';

// node:sqlite is still flagged experimental; keep that one warning out of CLI output.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.warn(w);
});

const src = new URL('../src/cli/index.ts', import.meta.url);
await import(existsSync(src) ? src.href : new URL('../dist/cli/index.js', import.meta.url).href);
