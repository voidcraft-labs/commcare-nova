import { asMediaAssetId, type MediaAssetId } from "@/lib/domain/multimedia";
import { asUuid, type Uuid, uuidSchema } from "@/lib/domain/uuid";

/**
 * Deterministic valid identity for test fixtures.
 *
 * Tests should stay free to use readable labels such as `"module-a"` without
 * weakening the production UUID parser. Already-canonical UUIDs pass through
 * unchanged; every other label is folded into a stable lowercase,
 * version-5-shaped RFC UUID. This helper is test-only and never participates in
 * runtime admission or migration.
 */
export function testUuid(label: string): Uuid {
	const parsed = uuidSchema.safeParse(label);
	if (parsed.success) return parsed.data;

	const words = [
		fnv1a(label, 0x811c9dc5),
		fnv1a(label, 0x9e3779b9),
		fnv1a(label, 0x85ebca6b),
		fnv1a(label, 0xc2b2ae35),
	];
	const hex = words.map((word) => word.toString(16).padStart(8, "0")).join("");
	const uuid = [
		hex.slice(0, 8),
		hex.slice(8, 12),
		`5${hex.slice(13, 16)}`,
		`a${hex.slice(17, 20)}`,
		hex.slice(20),
	].join("-");
	return asUuid(uuid);
}

/** Deterministic valid uploaded-media identity for test fixtures. */
export function testMediaAssetId(label: string): MediaAssetId {
	return asMediaAssetId(testUuid(`media:${label}`));
}

function fnv1a(value: string, seed: number): number {
	let hash = seed >>> 0;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}
