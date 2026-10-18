/**
 * Accessibility tests against the built site, served by `astro preview`:
 * run `bun run build` first, then `bun run test:a11y`.
 */
import { defineConfig } from "@playwright/test";

const PORT = 4329;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  reporter: "list",
  use: { baseURL: `http://localhost:${PORT}/mercury-fw/` },
  webServer: {
    command: `bunx --bun astro preview --port ${PORT} --ignore-lock`,
    url: `http://localhost:${PORT}/mercury-fw/`,
    reuseExistingServer: !process.env.CI,
  },
});
