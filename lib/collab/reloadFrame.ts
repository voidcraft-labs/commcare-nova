/**
 * The control frame for `event: reload`, and what a tab says once the reload
 * it asks for has landed.
 *
 * Every arm reloads: a frame this parser refuses still reloads the tab, it
 * only says nothing afterwards. The `hq-changes` arm names the bring-in of
 * changes made in CommCare HQ that forced the reload: its batch id, so the
 * tab whose own request sent that batch says nothing (that tab shows the
 * answer to its request), and the member who chose it, so every other tab
 * can say who.
 */

import { z } from "zod";
import type { PresenceFrame } from "@/lib/collab/presenceTypes";
import { hqChangesBroughtInToast } from "@/lib/publish/hqChangesCopy";

export const reloadFrameSchema = z.union([
	z.strictObject({
		reason: z.enum([
			"replay-unavailable",
			"app-changed",
			"authorization-changed",
		]),
	}),
	z.strictObject({
		reason: z.literal("hq-changes"),
		batchId: z.string().min(1),
		actorId: z.string().min(1),
	}),
]);

export type ReloadFrame = z.infer<typeof reloadFrameSchema>;

export function parseReloadFrame(data: string): ReloadFrame | null {
	try {
		const parsed = reloadFrameSchema.safeParse(JSON.parse(data));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/**
 * The notice a tab shows once the reload `frame` asked for has landed, or
 * `null` for none: only a bring-in of changes made in CommCare HQ is said,
 * and never in the tab whose own request sent its batch (`ownBatchIds`).
 * The member is named from `roster`, the presence the tab held when the
 * frame arrived, before the reload cleared it; a member the roster does not
 * hold, or holds with no name, is named by the copy's fallback.
 */
export function reloadNotice(
	frame: ReloadFrame | null,
	ownBatchIds: ReadonlySet<string>,
	roster: PresenceFrame,
): string | null {
	if (frame?.reason !== "hq-changes") return null;
	if (ownBatchIds.has(frame.batchId)) return null;
	const name = roster
		.find((entry) => entry.userId === frame.actorId && entry.name.trim() !== "")
		?.name.trim();
	return hqChangesBroughtInToast(name ?? null);
}
