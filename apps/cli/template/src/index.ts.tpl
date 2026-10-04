/**
 * Service entrypoint: builds the app with `composeMercury`, fed
 * `mercury.config.ts`, and starts what a long-running service runs: the
 * declared channels and the memory crons.
 * Headless; the interactive terminal is `bun run repl` (`repl.ts`).
 *
 * Stays alive on the channels' background resources and the cron intervals,
 * and shuts down on SIGINT/SIGTERM (what `docker compose stop` sends).
 */
import { composeMercury, loadChannels, type LoadedChannel } from "@mercury-fw/core";
import mercuryConfig from "../mercury.config.ts";

const app = await composeMercury(mercuryConfig);

const loadedChannels: LoadedChannel[] = loadChannels(app.channels, { runtime: app.channelRuntime });
for (const { name, provider } of loadedChannels) {
  await provider.start(app.handleTurn);
  console.error(`[channel] ${name} started`);
}

const crons = app.startCrons();
console.error("[service] up — channels and crons started; waiting for SIGINT/SIGTERM");

// Release everything that holds the event loop open, then exit: the model and
// Qdrant clients keep pooled sockets with no dispose. Guarded so a second
// signal during teardown doesn't run it twice.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[shutdown] ${signal} received, releasing subsystems`);
  crons.stop();
  for (const { name, provider } of loadedChannels) {
    await provider.stop?.();
    console.error(`[shutdown] channel ${name} stopped`);
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
