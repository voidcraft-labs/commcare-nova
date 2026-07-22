import "server-only";

import { RUNTIME_CAPABILITIES } from "@/lib/runtimeCapabilities";
import {
	canonicalRuntimeCapabilityManifest,
	type RuntimeCapabilityManifest,
	runtimeCapabilityEnvironmentFromHash,
	runtimeCapabilityRevisionLabelsFromHash,
} from "@/lib/runtimeCapabilities/core.mjs";
import { hashCanonicalRuntimeCapabilityManifest } from "@/lib/runtimeCapabilities/serverHash.mjs";

export function hashRuntimeCapabilityManifest(
	manifest: RuntimeCapabilityManifest,
): string {
	return hashCanonicalRuntimeCapabilityManifest(
		canonicalRuntimeCapabilityManifest(manifest),
	);
}

/** Full SHA-256 for server health and deploy-label verification. */
export const RUNTIME_CAPABILITY_MANIFEST_HASH =
	hashRuntimeCapabilityManifest(RUNTIME_CAPABILITIES);

export function runtimeCapabilityEnvironment(
	manifest: RuntimeCapabilityManifest,
): Readonly<Record<string, string>> {
	return runtimeCapabilityEnvironmentFromHash(
		manifest,
		hashRuntimeCapabilityManifest(manifest),
	);
}

export function runtimeCapabilityRevisionLabels(
	manifest: RuntimeCapabilityManifest,
	buildId: string,
): Readonly<Record<string, string>> {
	return runtimeCapabilityRevisionLabelsFromHash(
		manifest,
		hashRuntimeCapabilityManifest(manifest),
		buildId,
	);
}
