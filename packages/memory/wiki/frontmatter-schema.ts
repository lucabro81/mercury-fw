/**
 * Frontmatter schema for wiki notes, based on Open Knowledge
 * Format (OKF — https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing):
 * `type` is the only field OKF mandates; `source`/`confidence`/
 * `derived_from`/`last_reviewed`, the dreaming pass's status fields and
 * `locked` are Mercury-specific extensions, the
 * kind OKF explicitly leaves to the producer. `curated` and `inferred`
 * are validated as separate shapes (discriminated on `type`) because
 * only `inferred` notes carry provenance — a curated doc has no
 * meaningful `confidence` or `derived_from`.
 */
import { z } from "zod";

/** Where a note stands after the wiki's dreaming pass checked it against the conversations it was used in. */
export const NOTE_STATUSES = ["unverified", "verified", "contested", "validated"] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

/**
 * What the dreaming pass writes on a note it checked: `status`, when it last
 * checked it (`verified_at`), the turns its verdict rests on (`evidence`), and
 * when a person decided on it (`validated_at`). All optional: a note nobody
 * checked has none of them.
 */
const statusFields = {
  status: z.enum(NOTE_STATUSES).optional(),
  verified_at: z.string().optional(),
  evidence: z.array(z.string()).optional(),
  validated_at: z.string().optional(),
};

/** A note only people change: nothing the model writes (the nightly review, the dreaming pass) touches it. Absent on an unlocked note. */
const lockedField = { locked: z.literal(true).optional() };

export const CuratedFrontmatterSchema = z.object({
  type: z.literal("curated"),
  author: z.string().optional(),
  last_updated: z.string().optional(),
  ...statusFields,
  ...lockedField,
});

/** A note the model wrote for one person, in their own area (`personal/notes/`). Same shape as a curated doc, kept apart by `type` so promoting it to the common area is a visible change of kind. */
export const PersonalFrontmatterSchema = z.object({
  type: z.literal("personal"),
  last_updated: z.string().optional(),
  ...statusFields,
  ...lockedField,
});

export const InferredFrontmatterSchema = z.object({
  type: z.literal("inferred"),
  source: z.literal("agent"),
  confidence: z.enum(["low", "medium", "high"]),
  derived_from: z.array(z.string()).min(1),
  last_reviewed: z.string().nullable(),
  ...statusFields,
});

export type CuratedFrontmatter = z.infer<typeof CuratedFrontmatterSchema>;
export type PersonalFrontmatter = z.infer<typeof PersonalFrontmatterSchema>;
export type InferredFrontmatter = z.infer<typeof InferredFrontmatterSchema>;
