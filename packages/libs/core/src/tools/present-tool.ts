/**
 * The `present` tool: the model's explicit "show this artifact to the user"
 * action. A tool that produced a user-facing `display` stashed it in the
 * `DisplayStore` (see `display-store.ts`) and returned a `ref` on the model
 * channel; the model never sees the rendered content, only the ref. Calling
 * `present(ref)` marks that ref to be appended to the reply at finalize.
 *
 * This is what shrinks the model's job from "format this list correctly"
 * (which small models garble) to "show this list? yes/no": the artifact is
 * always the deterministic one the formatter produced, and the model only
 * decides whether it appears. If the model never calls `present`, nothing is
 * shown — the right outcome for a "how many are open?" question answered in
 * prose. Scoped to the calling session, so it can only surface its own refs.
 */
import type { ExecutableTool } from "@mercury-fw/plugin-types";
import { tool } from "ai";
import { z } from "zod";
import type { DisplayStore } from "./display-store.ts";

export type PresentToolDeps = { sessionKey: string; store: DisplayStore };

export function createPresentTool(deps: PresentToolDeps): { present: ExecutableTool } {
  const present = tool({
    description:
      "Show a previously produced artifact (e.g. a list of issues) to the user. Pass the `ref` a prior tool " +
      "result returned (its `displayRef`), or one listed under \"Lists already shown\" to show it again. " +
      "Call this ONLY when the user wants to see the artifact itself; if you " +
      "are answering in prose (a count, a yes/no, a single field), do NOT call it — the artifact stays hidden.",
    inputSchema: z.object({ ref: z.string().min(1) }),
    execute: async ({ ref }) => {
      if (!deps.store.surface(deps.sessionKey, ref)) {
        return {
          ok: false as const,
          error: `no artifact with ref "${ref}" to present. Only pass a displayRef returned by a tool result in this conversation.`,
        };
      }
      return { ok: true as const };
    },
  });

  return { present };
}
