/**
 * Watches a plugin's `build()` while the core composes it. The core's loader
 * skips a plugin whose build fails, on purpose (one broken plugin mustn't take
 * an app down), so a training run would go on without the plugin's tool and
 * score the skill on a model that can't follow it. Watched, that failure
 * becomes the task's.
 */
import type { Plugin } from "@mercury-fw/plugin-types";

/** `plugin` with its build watched, and why it didn't load (undefined when it
 * did, or when it has no build to fail). */
export function watchBuild(plugin: Plugin): { plugin: Plugin; failure: () => string | undefined } {
  const original = plugin.build;
  if (original === undefined) return { plugin, failure: () => undefined };
  let called = false;
  let error: string | undefined;
  const build: NonNullable<Plugin["build"]> = (ctx) => {
    called = true;
    try {
      return original(ctx);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  };
  return {
    plugin: { ...plugin, build },
    failure: () => {
      if (!called) return `the ${plugin.name} plugin didn't load: its build was never called`;
      return error === undefined ? undefined : `the ${plugin.name} plugin didn't load: ${error}`;
    },
  };
}
