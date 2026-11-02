/**
 * Exact current wire contract for `GET /api/apps/{id}`.
 *
 * The route and the browser reload path share this schema so an extra
 * row-shaped response key cannot become a rolling transport alias. The
 * blueprint is the complete persisted document; the reconciler hydrates its
 * derived indexes only after this whole response has parsed.
 *
 * `recordedHolds` is the hold each held target's latest recording wrote,
 * read in the same transaction as the blueprint
 * (`lib/db/appAccess.ts::resolveAuthorizedAppSnapshot`), in document order.
 * The builder page's first render carries the same entries through its
 * `initialAccess`, so the first load and every reload hand the tab one shape.
 */

import { z } from "zod";
import type {
	PlacementHold,
	RecordedPlacementHolds,
} from "@/lib/doc/placementHolds";
import { placementHoldSchema, placementTargetKey } from "@/lib/doc/types";
import { blueprintDocSchema } from "@/lib/domain";

/** One recorded hold: a target and the placement its latest recording wrote.
 *  A recording that clears nothing is no recording, so `null` is refused. */
const recordedPlacementHoldSchema = placementHoldSchema.refine(
	(hold) => hold.placement !== null,
	{
		message:
			"A recorded hold names the placement a recording wrote, so its placement cannot be empty.",
		path: ["placement"],
	},
) as z.ZodType<PlacementHold>;

/** The recorded holds, each target named at most once. */
export const recordedPlacementHoldsSchema = z
	.array(recordedPlacementHoldSchema)
	.superRefine((holds, ctx) => {
		const seen = new Set<string>();
		holds.forEach((hold, index) => {
			const key = placementTargetKey(hold);
			if (seen.has(key)) {
				ctx.addIssue({
					code: "custom",
					path: [index],
					message:
						"The recorded holds name one target twice. Each target has one latest recording.",
				});
			}
			seen.add(key);
		});
	});

export const appReadSnapshotSchema = z.strictObject({
	projectId: z.string().min(1),
	role: z.string().min(1),
	canEdit: z.boolean(),
	blueprint: blueprintDocSchema,
	baseSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	recordedHolds: recordedPlacementHoldsSchema,
});

export type AppReadSnapshot = z.infer<typeof appReadSnapshotSchema>;

/** Parse an untrusted HTTP response as one all-or-nothing current snapshot. */
export function parseAppReadSnapshot(value: unknown): AppReadSnapshot {
	return appReadSnapshotSchema.parse(value);
}

/** The recorded holds as the tab keeps them: keyed by `placementTargetKey`. */
export function recordedPlacementHoldsOf(
	holds: readonly PlacementHold[],
): RecordedPlacementHolds {
	return new Map(holds.map((hold) => [placementTargetKey(hold), hold]));
}
