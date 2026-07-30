/**
 * The presence roster frame the `/stream` route delivers (`event: presence`).
 *
 * P6 only needs the wire shape to route the frame through the provider's
 * `subscribePresence` seam; P7's presence layer (roster UI, follow, markers)
 * consumes it. Kept minimal + provider-adjacent so P6 ships the transport
 * without pulling in P7's UI types.
 */

import { z } from "zod";
import { locationSchema } from "@/lib/routing/types";

/** One peer's presence, keyed per browser session so a user's two tabs don't
 *  clobber (the roster dedupes self by `userId`). Mirrors the server
 *  `presenceDocSchema` projection minus the `expireAt` TTL field. */
export const presenceEntrySchema = z
	.object({
		userId: z.string().min(1),
		sessionId: z.string().min(1),
		name: z.string(),
		/** Avatar URL (server-stamped from the peer's session), or null — the
		 *  roster renders the photo with the palette color as ring + fallback. */
		image: z.string().nullable(),
		/** Account email (server-stamped like `image`) — the roster's hover
		 *  profile card shows it; empty string when the session carries none. */
		email: z.string(),
		color: z.string(),
		location: locationSchema,
		/** Epoch ms of the last heartbeat — a stale entry (> ~2× heartbeat) hides. */
		updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	})
	.strict();

/** The full roster snapshot a single `event: presence` frame carries. */
export const presenceFrameSchema = z.array(presenceEntrySchema);

export type PresenceEntry = z.infer<typeof presenceEntrySchema>;
export type PresenceFrame = z.infer<typeof presenceFrameSchema>;

export function parsePresenceFrame(data: string): PresenceFrame | null {
	try {
		const parsed = presenceFrameSchema.safeParse(JSON.parse(data));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
