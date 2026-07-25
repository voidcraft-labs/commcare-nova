/**
 * The one way a lookup byte count is written for a person.
 *
 * Shared by the service's refusals, the CSV route's refusals, and the Project
 * data workspace, so a message and the surface that shows it can never
 * disagree about how big something is.
 *
 * Binary units, because every cap in `constants.ts` is binary — 8 MiB is
 * 8 × 1024². Reporting that ceiling as "8.4 MB" beside a limit written as
 * "8 MB" is exactly the mismatch that makes a correct refusal look like a bug.
 * One decimal place above a kilobyte; bytes are exact, because a cell-level
 * measurement in the hundreds is more useful than "0.3 KB".
 *
 * Client-safe: no `server-only`, no database, no Node built-ins.
 */
export function formatLookupBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "an unknown size";
	if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
	const kib = bytes / 1024;
	if (kib < 1024) return `${roundToOneDecimal(kib)} KB`;
	return `${roundToOneDecimal(kib / 1024)} MB`;
}

function roundToOneDecimal(value: number): string {
	const rounded = Math.round(value * 10) / 10;
	return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** A count with its noun, so no call site hand-assembles "1 rows". */
export function formatLookupCount(count: number, singular: string): string {
	return `${count.toLocaleString("en-US")} ${count === 1 ? singular : `${singular}s`}`;
}
