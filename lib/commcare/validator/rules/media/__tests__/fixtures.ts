/**
 * Fixtures shared across the per-rule media validator tests.
 *
 * `makeAssetRecord(...)` produces a `MediaAssetRecord` literal whose
 * non-test-relevant fields are filled with sensible defaults. Each
 * test overrides just the slots its assertion turns on (the kind
 * mismatch for `mediaKindMatches`, the pending status for
 * `mediaAssetReady`).
 *
 * Hand-built rather than via the loader: `mediaAssetReady` asserts on
 * pending rows, which the production library list filters out — a
 * real-loader fixture for the kind/library surfaces wouldn't reach
 * those states. The validator's manifest loader
 * (`validationLoop.ts::loadManifestForLoop`) DOES include pending
 * rows, so this fixture matches production semantics for the SA
 * loop's manifest.
 */

import { Timestamp } from "@google-cloud/firestore";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { AssetMimeType, MediaAssetStatus } from "@/lib/domain/multimedia";
import { asAssetId } from "@/lib/domain/multimedia";

/** The owner string the rule-tests treat as "this app's owner". */
export const APP_OWNER = "owner-fixture";

/**
 * Build a `MediaAssetRecord` literal. Only `id` is positional because
 * every test threads a stable id between the doc reference and the
 * manifest entry; the rest are tagged overrides. The authoritative
 * `id` sits after `...overrides` so an override either supplies its
 * own id or falls through to the positional default — no post-spread
 * re-apply needed.
 */
export function makeAssetRecord(
	id: string,
	overrides: Partial<MediaAssetRecord> = {},
): MediaAssetRecord {
	const mimeType: AssetMimeType = overrides.mimeType ?? "image/png";
	const status: MediaAssetStatus = overrides.status ?? "ready";
	return {
		owner: APP_OWNER,
		contentHash: "a".repeat(64),
		mimeType,
		kind: overrides.kind ?? "image",
		extension: ".png",
		sizeBytes: 100,
		gcsObjectKey: `users/${APP_OWNER}/${"a".repeat(64)}.png`,
		originalFilename: `${id}.png`,
		displayName: id,
		status,
		// `Timestamp.fromMillis` constructs a deterministic stamp; tests
		// don't care about the value, only that the field is present.
		created_at: Timestamp.fromMillis(0),
		...overrides,
		id: asAssetId(overrides.id ?? id),
	};
}

/** Build a manifest map from a list of records, keyed by record.id. */
export function makeManifest(
	records: ReadonlyArray<MediaAssetRecord>,
): ReadonlyMap<string, MediaAssetRecord> {
	return new Map(records.map((r) => [r.id as string, r]));
}
