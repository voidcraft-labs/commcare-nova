import type { StoredLocation } from "./types";

/** Names can repeat; the app-wide unique site code makes a UUID choice exact. */
export function locationChoiceLabel(location: StoredLocation): string {
	return `${location.name} · ${location.siteCode}`;
}
