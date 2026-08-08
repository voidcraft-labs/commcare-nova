/**
 * Canonical JSON TEXT — the byte-exact serialization both digest ends share.
 *
 * Object keys recursively sorted by UTF-16 code point (locale-independent —
 * never `localeCompare`), then `JSON.stringify`. Inputs must already be
 * JSON-safe trees; `undefined`-valued own properties are dropped exactly as
 * `JSON.stringify` drops them, so a value and its JSON round-trip serialize
 * identically.
 *
 * Dependency-free (no `node:crypto`) so CLIENT code can verify a
 * server-issued canonical digest: the server hashes with `node:crypto`
 * (`lib/utils/canonicalJson.ts`), the browser with WebCrypto — both over
 * exactly this text.
 */

function canonicalize(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort();
	const out: Record<string, unknown> = {};
	for (const key of keys) out[key] = canonicalize(record[key]);
	return out;
}

/** The exact canonical JSON text a value digests over. Exported so tests
 *  can pin byte-level stability. */
export function canonicalJsonText(value: unknown): string {
	const text = JSON.stringify(canonicalize(value));
	if (text === undefined) {
		throw new Error(
			"A canonical digest requires a JSON-representable value, but this value serializes to nothing.",
		);
	}
	return text;
}
