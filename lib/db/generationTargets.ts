/**
 * Generation targets — the closed runtime scope a model run bills, streams,
 * and persists against (an app, or a pre-app design session).
 *
 * This module is a DEPENDENCY-FREE TYPE LEAF (zod aside), and must stay
 * one: the whole protocol layer — threads, stream chunks, run summaries,
 * usage, the agent contexts, client code — imports the union and the
 * column mappers from here, so any runtime import added here lands in
 * every one of those graphs. The database-reading resolver half lives in
 * `generationTargetScope.ts` (server-only, imported by routes), which is
 * where "may this caller touch this target" is answered.
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

/** The two nullable target columns every target-polymorphic table stores,
 * derived from one closed union — writers spread this so `app_id` XOR
 * `design_session_id` can never drift from the target value. */
export function generationTargetColumns(target: GenerationTarget): {
	app_id: string | null;
	design_session_id: string | null;
} {
	return target.kind === "app"
		? { app_id: target.appId, design_session_id: null }
		: { app_id: null, design_session_id: target.designSessionId };
}

/** Reconstruct the closed union from a row's nullable target columns —
 * exactly one must be present (the tables' CHECKs guarantee it; this throws
 * on a row that violates them rather than guessing). */
export function generationTargetFromColumns(row: {
	app_id: string | null;
	design_session_id: string | null;
}): GenerationTarget {
	if (row.app_id !== null && row.design_session_id === null) {
		return { kind: "app", appId: row.app_id };
	}
	if (row.design_session_id !== null && row.app_id === null) {
		return { kind: "design-session", designSessionId: row.design_session_id };
	}
	throw new Error(
		"A target-polymorphic row must carry exactly one generation target.",
	);
}
