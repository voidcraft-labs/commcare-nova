import { createHash } from "node:crypto";

/** A transport token for the canonical source proof. The stored proof and its
 * equality checks remain owned by localization. */
export function authoringFingerprint(canonical: string): string {
	return `source:${createHash("sha256").update(canonical).digest("base64url")}`;
}
