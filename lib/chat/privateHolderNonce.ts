import { createHash } from "node:crypto";

/** Count-preserving durable placeholder for a private holder capability. */
export const PRIVATE_HOLDER_NONCE_CHUNK_TYPE =
	"data-private-holder-nonce" as const;

/**
 * Non-secret binding carried by the durable marker. A UUIDv4 nonce has 122
 * random bits, so its SHA-256 digest is not feasibly reversible; the digest
 * lets reconnect prove that a thread still carries the marker's exact
 * generation without persisting the capability itself.
 */
export function holderNonceReplayDigest(holderNonce: string): string {
	return createHash("sha256").update(holderNonce, "utf8").digest("base64url");
}
