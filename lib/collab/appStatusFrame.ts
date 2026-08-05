/**
 * The browser-safe wire contract for one `app-status` SSE frame: the app
 * row's current lifecycle status, emitted by `/api/apps/{id}/stream` on
 * connect and again whenever its ~10 s reauthorization cadence observes the
 * status change.
 *
 * This is how a tab that is NOT attached to a run's chat stream (a second
 * tab of the same user, a Project co-member watching a teammate's build)
 * learns that a build finished or that an app fell back to build shape: the
 * reconciler routes the frame into the session store's `buildUnfinished`
 * latch, whose own-stream release (`data-done` / `data-build-complete`)
 * never fires in those tabs. The enum is the SAME closed vocabulary the
 * database admits (`APP_LIFECYCLE_STATUSES`), so the wire cannot drift from
 * the persisted union.
 */

import { z } from "zod";
import { APP_LIFECYCLE_STATUSES } from "@/lib/db/types";

export const appStatusFrameSchema = z
	.object({
		status: z.enum(APP_LIFECYCLE_STATUSES),
	})
	.strict();

export type AppStatusFrame = z.infer<typeof appStatusFrameSchema>;

/** Parse one SSE data payload without letting JSON or schema failures escape
 * the provider listener: a malformed frame returns `null` and the latch is
 * left alone (fail-safe: garbage must not move a pricing signal). */
export function parseAppStatusFrame(data: string): AppStatusFrame | null {
	try {
		const parsed = appStatusFrameSchema.safeParse(JSON.parse(data));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
