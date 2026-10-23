import { serve } from '@hono/node-server';
import { config } from '../config.ts';
import { createCtx } from '../core/context.ts';
import { publish } from '../core/events.ts';
import { syncIndex } from '../core/knowledge.ts';
import { Orchestrator } from '../runner/orchestrator.ts';
import { Scheduler } from '../runner/scheduler.ts';
import { createApp, status } from './app.ts';
import { startEventRelay } from './live.ts';
import { staleBuild } from './stale-build.ts';

const stale = staleBuild(import.meta.url);
if (stale && !process.env.BRAIN_ALLOW_STALE_BUILD) {
  console.error(`[brain] refusing to start an outdated build: ${stale}.\nRun \`pnpm build\` (or use \`pnpm dev\`), then start again. BRAIN_ALLOW_STALE_BUILD=1 skips this check.`);
  process.exit(1);
}

const ctx = createCtx(config);
const orch = new Orchestrator(ctx);
orch.recover();
syncIndex(ctx);

const app = createApp(ctx, orch);
const scheduler = new Scheduler(ctx, orch);
startEventRelay(ctx);

// Push status to the UI whenever sessions start or end.
const pushStatus = async () => publish('status', await status(ctx, orch));
setInterval(pushStatus, 15_000).unref();

const server = serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, (info) => {
  console.log(`[brain] http://localhost:${info.port}  BRAIN_DIR=${config.brainDir}  concurrency=${config.concurrency}`);
  scheduler.start();
});

let stopping = false;
async function shutdown(sig: string) {
  if (stopping) process.exit(1);
  stopping = true;
  console.log(`[brain] ${sig}: stopping scheduler, cancelling ${orch.active.size} running session(s)`);
  scheduler.stop();
  for (const id of orch.active.keys()) {
    try {
      orch.cancel(id);
    } catch {}
  }
  await Promise.race([orch.waitAll(), new Promise((r) => setTimeout(r, 8000))]);
  server.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
