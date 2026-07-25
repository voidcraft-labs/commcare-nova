import rawManifest from "@/config/runtime-capabilities.json";
import { requireRuntimeCapabilityManifest } from "@/lib/runtimeCapabilities/core.mts";

/**
 * The validated capability contract compiled into this revision.
 * Keep this module plain-Node-safe: `apps.ts` reaches it through the writer
 * declaration, read-only tsx inspectors load that graph outside Next, and the
 * browser receiver imports it without pulling in `node:crypto`.
 */
export const RUNTIME_CAPABILITIES =
	requireRuntimeCapabilityManifest(rawManifest);

export const EDIT_RUN_LEASE_SECONDS = RUNTIME_CAPABILITIES.editRunLeaseSeconds;
export const BUILD_STALENESS_SECONDS =
	RUNTIME_CAPABILITIES.buildStalenessSeconds;

export type { RuntimeCapabilityManifest } from "@/lib/runtimeCapabilities/core.mts";
export { canonicalRuntimeCapabilityManifest } from "@/lib/runtimeCapabilities/core.mts";
