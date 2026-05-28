/**
 * Fixtures shared across the per-rule media validator tests.
 *
 * `makeAssetRecord(...)` produces a `MediaAssetRecord` literal whose
 * non-test-relevant fields are filled with sensible defaults. Each
 * rule's test overrides just the field its assertion turns on (the
 * mismatch case for `mediaKindMatches`, the foreign owner for
 * `mediaAssetOwnership`, etc.). The hand-built fixture is the
 * cheapest faithful representation of what the manifest would
 * carry — `loadAssetsByIds` filters out the rows these rules are
 * meant to catch, so a real-loader fixture wouldn't exercise the
 * rules at all.
 */

import { Timestamp } from "@google-cloud/firestore";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { AssetMimeType, MediaAssetStatus } from "@/lib/domain/multimedia";
import { asAssetId } from "@/lib/domain/multimedia";

/** The owner string the rule-tests treat as "this app's owner". */
export const APP_OWNER = "owner-fixture";

/** A foreign owner the ownership rule tests use to construct the
 *  cross-owner state the production loader would normally suppress. */
export const FOREIGN_OWNER = "different-owner";

/**
 * Build a `MediaAssetRecord` literal. Only `id` is positional because
 * every test threads a stable id between the doc reference and the
 * manifest entry; the rest are tagged overrides.
 */
export function makeAssetRecord(
	id: string,
	overrides: Partial<MediaAssetRecord> = {},
): MediaAssetRecord {
	const mimeType: AssetMimeType = overrides.mimeType ?? "image/png";
	const status: MediaAssetStatus = overrides.status ?? "ready";
	const record: MediaAssetRecord = {
		id: asAssetId(id),
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
		// Keep `id` authoritative — overrides can override; default uses
		// the positional arg.
	};
	return { ...record, id: asAssetId(overrides.id ?? id) };
}

/** Build a manifest map from a list of records, keyed by record.id. */
export function makeManifest(
	records: ReadonlyArray<MediaAssetRecord>,
): ReadonlyMap<string, MediaAssetRecord> {
	return new Map(records.map((r) => [r.id as string, r]));
}
