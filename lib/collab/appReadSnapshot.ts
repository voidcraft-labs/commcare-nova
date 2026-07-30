/**
 * Exact current wire contract for `GET /api/apps/{id}`.
 *
 * The route and the browser reload path share this schema so an extra
 * row-shaped response key cannot become a rolling transport alias. The
 * blueprint is the complete persisted document; the reconciler hydrates its
 * derived indexes only after this whole response has parsed.
 */

import { z } from "zod";
import { blueprintDocSchema } from "@/lib/domain";

export const appReadSnapshotSchema = z
	.object({
		projectId: z.string().min(1),
		role: z.string().min(1),
		canEdit: z.boolean(),
		blueprint: blueprintDocSchema,
		baseSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	})
	.strict();

export type AppReadSnapshot = z.infer<typeof appReadSnapshotSchema>;

/** Parse an untrusted HTTP response as one all-or-nothing current snapshot. */
export function parseAppReadSnapshot(value: unknown): AppReadSnapshot {
	return appReadSnapshotSchema.parse(value);
}
