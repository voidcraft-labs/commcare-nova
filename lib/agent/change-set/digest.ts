/**
 * Canonical JS JSON digests — the one digest discipline every change-set
 * identity uses (`base_snapshot_digest`, `input_digest`, `mutation_digest`,
 * `committed_snapshot_digest`, finding fingerprints).
 *
 * SHA-256 hex over canonical JSON bytes: object keys recursively sorted by
 * UTF-16 code point (locale-independent — never `localeCompare`), then
 * `JSON.stringify`. Producer and verifier are both JavaScript, so
 * PostgreSQL's jsonb canonicalization never participates; the fold-baseline
 * digest (`nova_app_change_fold_snapshot_digest`, SQL-computed over
 * `jsonb::text`) is a separate domain and the two are never compared.
 *
 * Inputs must already be JSON-safe trees (admitted mutation batches,
 * `PersistableDoc` values, receipt payloads). `undefined`-valued own
 * properties are dropped exactly as `JSON.stringify` drops them, so a value
 * and its JSON round-trip digest identically.
 */

import { createHash } from "node:crypto";

/** The staging idempotency protocol version, hashed into every input digest
 *  so a future protocol change cannot silently replay old receipts. */
export const STAGING_PROTOCOL_VERSION = 1;

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

/** The exact canonical JSON text a value digests over. Exported so tests can
 *  pin byte-level stability. */
export function canonicalJsonText(value: unknown): string {
	const text = JSON.stringify(canonicalize(value));
	if (text === undefined) {
		throw new Error(
			"A change-set digest requires a JSON-representable value, but this value serializes to nothing.",
		);
	}
	return text;
}

/** SHA-256 hex over the canonical JSON bytes of `value`. */
export function canonicalJsonDigest(value: unknown): string {
	return createHash("sha256")
		.update(canonicalJsonText(value), "utf8")
		.digest("hex");
}

/**
 * The staging request's input digest: the caller's ACTUAL request — computed
 * over the raw projected input BEFORE handle resolution, so a retry compares
 * what the caller sent, while the stored mutation digest proves the resolved
 * canonical result.
 */
export function stagingInputDigest(args: {
	readonly toolName: string;
	readonly expectedWorkspaceRevision: number;
	readonly projectedInput: unknown;
}): string {
	return canonicalJsonDigest({
		stagingProtocolVersion: STAGING_PROTOCOL_VERSION,
		toolName: args.toolName,
		expectedWorkspaceRevision: args.expectedWorkspaceRevision,
		projectedInput: args.projectedInput,
	});
}
