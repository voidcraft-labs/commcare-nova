/**
 * Runtime/deployment capabilities that must remain coherent across a rolling
 * Cloud Run release. This leaf is deliberately browser-safe: receiver code may
 * read the validated declaration without pulling Node hashing into its bundle.
 */
export interface RuntimeCapabilityManifest {
	readonly schemaVersion: 1;
	readonly writerVersion: number;
	readonly streamReceiverVersion: number;
	readonly runtimeReaderVersion: number;
	readonly streamRegistryVersion: number;
	readonly cloudRunRequestSeconds: number;
	readonly streamLeaseGraceSeconds: number;
	readonly editRunLeaseSeconds: number;
	readonly buildStalenessSeconds: number;
}

export interface RuntimeCapabilityVersions {
	readonly writerVersion: number;
	readonly streamReceiverVersion: number;
	readonly runtimeReaderVersion: number;
	readonly streamRegistryVersion: number;
}

export type RuntimeCapabilityManifestParseResult =
	| { readonly ok: true; readonly manifest: RuntimeCapabilityManifest }
	| { readonly ok: false; readonly issues: readonly string[] };

const MANIFEST_KEYS = [
	"schemaVersion",
	"writerVersion",
	"streamReceiverVersion",
	"runtimeReaderVersion",
	"streamRegistryVersion",
	"cloudRunRequestSeconds",
	"streamLeaseGraceSeconds",
	"editRunLeaseSeconds",
	"buildStalenessSeconds",
] as const;

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const CLOUD_RUN_REQUEST_SECONDS_MAX = 3_600;
const STREAM_LEASE_GRACE_SECONDS_MAX = 3_600;
const RUN_LIVENESS_SECONDS_MAX = 24 * 60 * 60;
const MANIFEST_LABEL_HASH_LENGTH = 16;

export const RUNTIME_CAPABILITY_LABEL_KEYS = Object.freeze({
	writerVersion: "nova_writer",
	streamReceiverVersion: "nova_stream_receiver",
	runtimeReaderVersion: "nova_runtime_reader",
	streamRegistryVersion: "nova_stream_registry",
	manifestHash: "nova_manifest",
	buildId: "nova_build",
} as const);

export const RUNTIME_CAPABILITY_ENV_KEYS = Object.freeze({
	writerVersion: "NOVA_WRITER_VERSION",
	streamReceiverVersion: "NOVA_STREAM_RECEIVER_VERSION",
	runtimeReaderVersion: "NOVA_RUNTIME_READER_VERSION",
	streamRegistryVersion: "NOVA_STREAM_REGISTRY_VERSION",
	cloudRunRequestSeconds: "NOVA_CLOUD_RUN_REQUEST_SECONDS",
	streamLeaseGraceSeconds: "NOVA_STREAM_LEASE_GRACE_SECONDS",
	streamLeaseTtlSeconds: "NOVA_STREAM_LEASE_TTL_SECONDS",
	editRunLeaseSeconds: "NOVA_EDIT_RUN_LEASE_SECONDS",
	buildStalenessSeconds: "NOVA_BUILD_STALENESS_SECONDS",
	manifestHash: "NOVA_RUNTIME_CAPABILITY_MANIFEST_HASH",
} as const);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function validateInteger(
	record: Record<string, unknown>,
	key: string,
	minimum: number,
	maximum: number,
	issues: string[],
): number | null {
	const value = record[key];
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < minimum ||
		value > maximum
	) {
		issues.push(`${key} must be an integer from ${minimum} through ${maximum}`);
		return null;
	}
	return value;
}

function validateWholeMinuteSeconds(
	record: Record<string, unknown>,
	key: string,
	issues: string[],
): number | null {
	const value = validateInteger(
		record,
		key,
		60,
		RUN_LIVENESS_SECONDS_MAX,
		issues,
	);
	if (value === null) return null;
	if (value % 60 !== 0) {
		issues.push(`${key} must be an exact whole-minute duration`);
		return null;
	}
	return value;
}

/**
 * Parse the checked-in manifest with an exact-key, exact-range contract.
 * Unknown keys are rejected so a misspelling cannot silently become a v0
 * declaration while the rest of the build appears healthy.
 */
export function parseRuntimeCapabilityManifest(
	input: unknown,
): RuntimeCapabilityManifestParseResult {
	if (!isPlainRecord(input)) {
		return { ok: false, issues: ["manifest must be a JSON object"] };
	}

	const issues: string[] = [];
	const actualKeys = Object.keys(input).sort();
	const expectedKeys = [...MANIFEST_KEYS].sort();
	const missing = expectedKeys.filter((key) => !(key in input));
	const unknown = actualKeys.filter(
		(key) => !expectedKeys.includes(key as (typeof expectedKeys)[number]),
	);
	if (missing.length > 0) issues.push(`missing keys: ${missing.join(", ")}`);
	if (unknown.length > 0) issues.push(`unknown keys: ${unknown.join(", ")}`);

	const schemaVersion = validateInteger(input, "schemaVersion", 1, 1, issues);
	const writerVersion = validateInteger(
		input,
		"writerVersion",
		0,
		POSTGRES_INTEGER_MAX,
		issues,
	);
	const streamReceiverVersion = validateInteger(
		input,
		"streamReceiverVersion",
		0,
		POSTGRES_INTEGER_MAX,
		issues,
	);
	const runtimeReaderVersion = validateInteger(
		input,
		"runtimeReaderVersion",
		0,
		POSTGRES_INTEGER_MAX,
		issues,
	);
	const streamRegistryVersion = validateInteger(
		input,
		"streamRegistryVersion",
		0,
		POSTGRES_INTEGER_MAX,
		issues,
	);
	const cloudRunRequestSeconds = validateInteger(
		input,
		"cloudRunRequestSeconds",
		1,
		CLOUD_RUN_REQUEST_SECONDS_MAX,
		issues,
	);
	const streamLeaseGraceSeconds = validateInteger(
		input,
		"streamLeaseGraceSeconds",
		1,
		STREAM_LEASE_GRACE_SECONDS_MAX,
		issues,
	);
	const editRunLeaseSeconds = validateWholeMinuteSeconds(
		input,
		"editRunLeaseSeconds",
		issues,
	);
	const buildStalenessSeconds = validateWholeMinuteSeconds(
		input,
		"buildStalenessSeconds",
		issues,
	);

	if (
		issues.length > 0 ||
		schemaVersion === null ||
		writerVersion === null ||
		streamReceiverVersion === null ||
		runtimeReaderVersion === null ||
		streamRegistryVersion === null ||
		cloudRunRequestSeconds === null ||
		streamLeaseGraceSeconds === null ||
		editRunLeaseSeconds === null ||
		buildStalenessSeconds === null
	) {
		return { ok: false, issues };
	}

	return {
		ok: true,
		manifest: Object.freeze({
			schemaVersion: 1,
			writerVersion,
			streamReceiverVersion,
			runtimeReaderVersion,
			streamRegistryVersion,
			cloudRunRequestSeconds,
			streamLeaseGraceSeconds,
			editRunLeaseSeconds,
			buildStalenessSeconds,
		}),
	};
}

export function requireRuntimeCapabilityManifest(
	input: unknown,
): RuntimeCapabilityManifest {
	const result = parseRuntimeCapabilityManifest(input);
	if (result.ok) return result.manifest;
	throw new Error(
		`Invalid runtime capability manifest: ${result.issues.join("; ")}`,
	);
}

/** Stable canonical bytes for both the image declaration and deploy label. */
export function canonicalRuntimeCapabilityManifest(
	manifest: RuntimeCapabilityManifest,
): string {
	return JSON.stringify({
		schemaVersion: manifest.schemaVersion,
		writerVersion: manifest.writerVersion,
		streamReceiverVersion: manifest.streamReceiverVersion,
		runtimeReaderVersion: manifest.runtimeReaderVersion,
		streamRegistryVersion: manifest.streamRegistryVersion,
		cloudRunRequestSeconds: manifest.cloudRunRequestSeconds,
		streamLeaseGraceSeconds: manifest.streamLeaseGraceSeconds,
		editRunLeaseSeconds: manifest.editRunLeaseSeconds,
		buildStalenessSeconds: manifest.buildStalenessSeconds,
	});
}

export function streamLeaseTtlSeconds(
	manifest: RuntimeCapabilityManifest,
): number {
	return manifest.cloudRunRequestSeconds + manifest.streamLeaseGraceSeconds;
}

/**
 * Revision labels and environment declarations are untrusted control-plane
 * strings. Missing, signed, fractional, padded, overflowing, or otherwise
 * malformed values are capability v0 — never an exception and never a partial
 * parse such as `parseInt("1-old") === 1`.
 */
export function parseRuntimeCapabilityVersion(value: unknown): number {
	if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
		return 0;
	}
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed <= POSTGRES_INTEGER_MAX
		? parsed
		: 0;
}

function declarationsFromKeys(
	input: unknown,
	keys: {
		readonly writerVersion: string;
		readonly streamReceiverVersion: string;
		readonly runtimeReaderVersion: string;
		readonly streamRegistryVersion: string;
	},
): RuntimeCapabilityVersions {
	const record = isPlainRecord(input) ? input : {};
	return Object.freeze({
		writerVersion: parseRuntimeCapabilityVersion(record[keys.writerVersion]),
		streamReceiverVersion: parseRuntimeCapabilityVersion(
			record[keys.streamReceiverVersion],
		),
		runtimeReaderVersion: parseRuntimeCapabilityVersion(
			record[keys.runtimeReaderVersion],
		),
		streamRegistryVersion: parseRuntimeCapabilityVersion(
			record[keys.streamRegistryVersion],
		),
	});
}

export function parseRevisionCapabilityLabels(
	input: unknown,
): RuntimeCapabilityVersions {
	return declarationsFromKeys(input, RUNTIME_CAPABILITY_LABEL_KEYS);
}

export function parseRuntimeCapabilityEnvironment(
	input: unknown,
): RuntimeCapabilityVersions {
	return declarationsFromKeys(input, RUNTIME_CAPABILITY_ENV_KEYS);
}

function requireManifestHash(manifestHash: string): string {
	if (!/^[a-f0-9]{64}$/.test(manifestHash)) {
		throw new Error("manifestHash must be one lowercase SHA-256 hex digest");
	}
	return manifestHash;
}

export function runtimeCapabilityEnvironmentFromHash(
	manifest: RuntimeCapabilityManifest,
	manifestHash: string,
): Readonly<Record<string, string>> {
	return Object.freeze({
		[RUNTIME_CAPABILITY_ENV_KEYS.writerVersion]: String(manifest.writerVersion),
		[RUNTIME_CAPABILITY_ENV_KEYS.streamReceiverVersion]: String(
			manifest.streamReceiverVersion,
		),
		[RUNTIME_CAPABILITY_ENV_KEYS.runtimeReaderVersion]: String(
			manifest.runtimeReaderVersion,
		),
		[RUNTIME_CAPABILITY_ENV_KEYS.streamRegistryVersion]: String(
			manifest.streamRegistryVersion,
		),
		[RUNTIME_CAPABILITY_ENV_KEYS.cloudRunRequestSeconds]: String(
			manifest.cloudRunRequestSeconds,
		),
		[RUNTIME_CAPABILITY_ENV_KEYS.streamLeaseGraceSeconds]: String(
			manifest.streamLeaseGraceSeconds,
		),
		[RUNTIME_CAPABILITY_ENV_KEYS.streamLeaseTtlSeconds]: String(
			streamLeaseTtlSeconds(manifest),
		),
		[RUNTIME_CAPABILITY_ENV_KEYS.editRunLeaseSeconds]: String(
			manifest.editRunLeaseSeconds,
		),
		[RUNTIME_CAPABILITY_ENV_KEYS.buildStalenessSeconds]: String(
			manifest.buildStalenessSeconds,
		),
		[RUNTIME_CAPABILITY_ENV_KEYS.manifestHash]:
			requireManifestHash(manifestHash),
	});
}

function requireLabelValue(value: string, name: string): string {
	if (
		value.length < 1 ||
		value.length > 63 ||
		!/^[a-z0-9](?:[-_a-z0-9]{0,61}[a-z0-9])?$/.test(value)
	) {
		throw new Error(`${name} is not a valid Google Cloud label value`);
	}
	return value;
}

export function runtimeCapabilityRevisionLabelsFromHash(
	manifest: RuntimeCapabilityManifest,
	manifestHash: string,
	buildId: string,
): Readonly<Record<string, string>> {
	const manifestLabelHash = requireManifestHash(manifestHash).slice(
		0,
		MANIFEST_LABEL_HASH_LENGTH,
	);
	return Object.freeze({
		[RUNTIME_CAPABILITY_LABEL_KEYS.writerVersion]: String(
			manifest.writerVersion,
		),
		[RUNTIME_CAPABILITY_LABEL_KEYS.streamReceiverVersion]: String(
			manifest.streamReceiverVersion,
		),
		[RUNTIME_CAPABILITY_LABEL_KEYS.runtimeReaderVersion]: String(
			manifest.runtimeReaderVersion,
		),
		[RUNTIME_CAPABILITY_LABEL_KEYS.streamRegistryVersion]: String(
			manifest.streamRegistryVersion,
		),
		[RUNTIME_CAPABILITY_LABEL_KEYS.manifestHash]: manifestLabelHash,
		[RUNTIME_CAPABILITY_LABEL_KEYS.buildId]: requireLabelValue(
			buildId,
			"buildId",
		),
	});
}
