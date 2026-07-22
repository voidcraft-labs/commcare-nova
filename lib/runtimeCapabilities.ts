import rawManifest from "@/config/runtime-capabilities.json";
import {
	requireRuntimeCapabilityManifest,
	streamLeaseTtlSeconds,
} from "@/lib/runtimeCapabilities/core.mjs";

/**
 * The validated capability contract compiled into this revision.
 * Keep this module plain-Node-safe: `apps.ts` reaches it through the writer
 * declaration, read-only tsx inspectors load that graph outside Next, and the
 * browser receiver imports it without pulling in `node:crypto`.
 */
export const RUNTIME_CAPABILITIES =
	requireRuntimeCapabilityManifest(rawManifest);

/**
 * A stream can remain alive for the request cap plus cleanup/reconnect grace.
 * Neither independently declared run-liveness clock derives from this value.
 */
export const STREAM_LEASE_TTL_SECONDS =
	streamLeaseTtlSeconds(RUNTIME_CAPABILITIES);

export const EDIT_RUN_LEASE_SECONDS = RUNTIME_CAPABILITIES.editRunLeaseSeconds;
export const BUILD_STALENESS_SECONDS =
	RUNTIME_CAPABILITIES.buildStalenessSeconds;

export type {
	RuntimeCapabilityManifest,
	RuntimeCapabilityVersions,
} from "@/lib/runtimeCapabilities/core.mjs";
export {
	canonicalRuntimeCapabilityManifest,
	parseRevisionCapabilityLabels,
	parseRuntimeCapabilityEnvironment,
	parseRuntimeCapabilityVersion,
} from "@/lib/runtimeCapabilities/core.mjs";
