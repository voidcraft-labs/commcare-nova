/**
 * Canonical JS JSON digests — one digest discipline for values whose
 * producer AND verifier are both JavaScript (change-set identities, receipt
 * payloads, finding fingerprints).
 *
 * SHA-256 hex over canonical JSON bytes: object keys recursively sorted by
 * UTF-16 code point (locale-independent — never `localeCompare`), then
 * `JSON.stringify`. PostgreSQL's jsonb canonicalization never participates;
 * the fold-baseline digest (`nova_app_change_fold_snapshot_digest`,
 * SQL-computed over `jsonb::text`) is a separate domain and the two are
 * never compared.
 *
 * Inputs must already be JSON-safe trees. `undefined`-valued own properties
 * are dropped exactly as `JSON.stringify` drops them, so a value and its
 * JSON round-trip digest identically.
 *
 * Dependency-free leaf (node:crypto only) so both `lib/db` and the agent
 * layer can share one implementation.
 */

import { createHash } from "node:crypto";
import { canonicalJsonText } from "./canonicalJsonText";

/* The canonicalization + text serialization live in `canonicalJsonText.ts`,
 * a browser-safe leaf, so a client can verify a server digest over the same
 * bytes with WebCrypto. This module adds only the node-side hash. */
export { canonicalJsonText };

/** SHA-256 hex over the canonical JSON bytes of `value`. */
export function canonicalJsonDigest(value: unknown): string {
	return createHash("sha256")
		.update(canonicalJsonText(value), "utf8")
		.digest("hex");
}
