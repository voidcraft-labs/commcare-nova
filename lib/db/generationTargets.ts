/**
 * Generation targets — the closed runtime scope a model run bills, streams,
 * and persists against: an app, or a pre-app design session.
 *
 * This file is deliberately a TYPE LEAF. The shared resolver boundary the
 * reviewed-intent plan describes (§11.1 — Project membership resolution,
 * holder/liveness projection, thread target checks, stream authorization,
 * opaque not-found behavior) ships with the design-session unit, which
 * builds it around this union — the same landed-early pattern as
 * `lib/agent/design/ids.ts`. Nothing here reads the database.
 */

import { z } from "zod";

export const generationTargetSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("app"), appId: z.string().min(1) }).strict(),
	z
		.object({
			kind: z.literal("design-session"),
			designSessionId: z.string().uuid(),
		})
		.strict(),
]);
export type GenerationTarget = z.infer<typeof generationTargetSchema>;
