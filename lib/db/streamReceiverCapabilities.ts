import "server-only";

import {
	parseRuntimeCapabilityEnvironment,
	parseRuntimeCapabilityVersion,
	RUNTIME_CAPABILITIES,
	type RuntimeCapabilityVersions,
} from "@/lib/runtimeCapabilities";

export const STREAM_RECEIVER_VERSION_QUERY_PARAM = "receiverVersion";

const STREAM_REGISTRY_VERSION_REQUIRED_FOR_RECEIVERS = 1;

type StreamReceiverCapabilityDeclaration = Pick<
	RuntimeCapabilityVersions,
	"streamReceiverVersion" | "streamRegistryVersion"
>;

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
 * A serving revision supports only what both its compiled code and deployed
 * environment declare. Receivers are unusable unless both halves also declare
 * the stream registry introduced with receiver v1.
 */
export function resolveServingStreamReceiverVersion(
	compiled: StreamReceiverCapabilityDeclaration,
	deployed: StreamReceiverCapabilityDeclaration,
): number {
	if (
		compiled.streamRegistryVersion <
			STREAM_REGISTRY_VERSION_REQUIRED_FOR_RECEIVERS ||
		deployed.streamRegistryVersion <
			STREAM_REGISTRY_VERSION_REQUIRED_FOR_RECEIVERS
	) {
		return 0;
	}

	return Math.min(
		compiled.streamReceiverVersion,
		deployed.streamReceiverVersion,
	);
}

/** Resolve this serving revision's fail-closed receiver capability. */
export function resolveDeployedStreamReceiverVersion(
	environment: unknown,
): number {
	return resolveServingStreamReceiverVersion(
		RUNTIME_CAPABILITIES,
		parseRuntimeCapabilityEnvironment(environment),
	);
}

/** Resolve the capability that may be admitted for one browser connection. */
export function resolveEffectiveStreamReceiverVersion(
	searchParams: URLSearchParams,
	environment: unknown,
): number {
	return Math.min(
		parseClientStreamReceiverVersion(searchParams),
		resolveDeployedStreamReceiverVersion(environment),
	);
}
