import "server-only";

import {
	parseRuntimeCapabilityVersion,
	RUNTIME_CAPABILITIES,
} from "@/lib/runtimeCapabilities";

export const STREAM_RECEIVER_VERSION_QUERY_PARAM = "receiverVersion";

const STREAM_REGISTRY_VERSION_REQUIRED_FOR_RECEIVERS = 1;

/**
 * Read the browser bundle's receiver declaration from an EventSource URL.
 * Exactly one declaration is required; the shared strict parser makes every
 * malformed declaration capability v0.
 */
export function parseClientStreamReceiverVersion(
	searchParams: URLSearchParams,
): number {
	const declarations = searchParams.getAll(STREAM_RECEIVER_VERSION_QUERY_PARAM);
	if (declarations.length !== 1) return 0;
	return parseRuntimeCapabilityVersion(declarations[0]);
}

/**
 * The serving revision's receiver capability is its compiled manifest,
 * receiver-usable only with the stream registry it ships. The baked image
 * environment is deliberately not consulted here: the startup probe already
 * refuses to serve an instance whose environment differs from the compiled
 * declaration, so a second runtime clamp could disagree only in environments
 * with no baked declaration at all (local dev, CI), where it would wrongly
 * fail closed and revoke every stream at a nonzero floor.
 */
export function resolveServingStreamReceiverVersion(): number {
	if (
		RUNTIME_CAPABILITIES.streamRegistryVersion <
		STREAM_REGISTRY_VERSION_REQUIRED_FOR_RECEIVERS
	) {
		return 0;
	}
	return RUNTIME_CAPABILITIES.streamReceiverVersion;
}

/** Resolve the capability that may be admitted for one browser connection. */
export function resolveEffectiveStreamReceiverVersion(
	searchParams: URLSearchParams,
): number {
	return Math.min(
		parseClientStreamReceiverVersion(searchParams),
		resolveServingStreamReceiverVersion(),
	);
}
