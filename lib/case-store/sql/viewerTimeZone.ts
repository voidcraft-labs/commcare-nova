/**
 * IANA `Area/Location` shape — at least one `/`-joined segment. Bare
 * numeric-offset spellings, abbreviations, and single-word names never
 * match.
 */
const IANA_AREA_LOCATION_RE =
	/^[A-Za-z_][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/;

/**
 * Resolve the viewer timezone binding to a zone name safe to hand to
 * Postgres `timezone(...)`. The value is client-supplied; anything but a
 * recognized IANA `Area/Location` name (or literal `UTC`) falls back to
 * UTC — deterministic, never the unpinned session zone.
 *
 * Intl acceptance alone is NOT sufficient: ICU also accepts bare offset
 * spellings like `+05:30`, which Postgres `timezone(...)` reads with the
 * POSIX-inverted sign (5½ hours WEST), silently flipping every rendered
 * time. The shape gate rejects those before the Intl check. A shaped name
 * ICU knows but the server's Postgres tzdata doesn't would still error the
 * query — the two catalogs are independent — but browsers report canonical
 * IANA names, and Postgres tracks the same tzdata releases, so the shape +
 * Intl pair is the practical gate.
 */
export function resolveViewerTimeZone(
	viewerTimeZone: string | undefined,
): string {
	if (viewerTimeZone === undefined || viewerTimeZone === "UTC") return "UTC";
	if (!IANA_AREA_LOCATION_RE.test(viewerTimeZone)) return "UTC";
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: viewerTimeZone });
		return viewerTimeZone;
	} catch {
		return "UTC";
	}
}
