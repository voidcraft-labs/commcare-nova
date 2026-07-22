import { createHash } from "node:crypto";

/**
 * Node-only canonical hashing primitive. Browser code imports the validated
 * manifest/core leaves and never reaches this module. The public Next server
 * entry is `server.ts`; the pre-install Cloud Build renderer imports this
 * dependency-free leaf directly because `server-only` is not installed yet.
 */
export function hashCanonicalRuntimeCapabilityManifest(
	canonicalManifest: string,
): string {
	return createHash("sha256").update(canonicalManifest, "utf8").digest("hex");
}
