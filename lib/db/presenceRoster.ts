/**
 * Server projection for one complete current presence roster.
 *
 * Every row is projected and the resulting array is parsed before a caller
 * emits any item. One malformed stored row therefore rejects the page instead
 * of publishing a partial roster that looks authoritative.
 */

import {
	type PresenceEntry,
	type PresenceFrame,
	presenceFrameSchema,
} from "@/lib/collab/presenceTypes";
import { locationSchema } from "@/lib/routing/types";

export interface PresenceRosterRow {
	user_id: string;
	session_id: string;
	name: string;
	image: string | null;
	email: string;
	color: string;
	location: unknown;
	updated_at: Date;
}

function projectPresenceRow(row: PresenceRosterRow): PresenceEntry {
	return {
		userId: row.user_id,
		sessionId: row.session_id,
		name: row.name,
		image: row.image,
		email: row.email,
		color: row.color,
		location: locationSchema.parse(row.location),
		updatedAt: row.updated_at.getTime(),
	};
}

export function projectPresenceRoster(
	rows: readonly PresenceRosterRow[],
): PresenceFrame {
	return presenceFrameSchema.parse(rows.map(projectPresenceRow));
}
