/**
 * The presence roster frame the `/stream` route delivers (`event: presence`).
 *
 * P6 only needs the wire shape to route the frame through the provider's
 * `subscribePresence` seam; P7's presence layer (roster UI, follow, markers)
 * consumes it. Kept minimal + provider-adjacent so P6 ships the transport
 * without pulling in P7's UI types.
 */

import type { Location } from "@/lib/routing/types";

/** One peer's presence, keyed per browser session so a user's two tabs don't
 *  clobber (the roster dedupes self by `userId`). Mirrors the server
 *  `presenceDocSchema` projection minus the `expireAt` TTL field. */
export interface PresenceEntry {
	readonly userId: string;
	readonly sessionId: string;
	readonly name: string;
	/** Avatar URL (server-stamped from the peer's session), or null — the
	 *  roster renders the photo with the palette color as ring + fallback. */
	readonly image: string | null;
	readonly color: string;
	readonly location: Location;
	/** Epoch ms of the last heartbeat — a stale entry (> ~2× heartbeat) hides. */
	readonly updatedAt: number;
}

/** The full roster snapshot a single `event: presence` frame carries. */
export type PresenceFrame = readonly PresenceEntry[];
