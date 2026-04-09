/**
 * Shared Firestore client and formatting helpers for diagnostic scripts.
 *
 * Uses Application Default Credentials (`gcloud auth application-default login`).
 * Import `db` directly — no lazy init needed outside the server runtime.
 */
import "dotenv/config";
import { Firestore } from "@google-cloud/firestore";

export const db = new Firestore({
	projectId: process.env.GOOGLE_CLOUD_PROJECT,
	ignoreUndefinedProperties: true,
	preferRest: true,
});

/** Firestore Timestamp → ISO string, with fallback for missing values. */
export function tsToISO(ts: { toDate(): Date } | undefined | null): string {
	return ts?.toDate?.().toISOString() ?? "(missing)";
}

/** Truncate a string for display, appending "…" if trimmed. */
export function truncate(str: string, maxLen = 120): string {
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen)}…`;
}

/** Format a number with commas for display. */
export function tok(n: number): string {
	return n.toLocaleString();
}
