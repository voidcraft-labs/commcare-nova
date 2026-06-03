// lib/media/mediaValidation.ts
//
// The media-validation gate for the media-ON wire-emission entry points
// (the HQ upload routes/tools + the `.ccz` compile route/tool). Those
// entry points expand media-ON, where a stale media reference (deleted,
// still-pending, foreign-owned, or kind-mismatched asset) makes
// `expandDoc` throw `requireAssetRef` — surfacing to the user as an
// opaque 500 / generic tool error. This gate runs the same media rules
// the SA validation loop runs, BEFORE expand, so the user instead gets
// the rule's actionable Elm-shape message with the carrier location.
//
// Server-only: it reads Firestore (the owner's asset rows). It is the
// only media-side consumer of `lib/commcare/validator`; the manifest
// builder (`lib/media/manifest.ts`) crosses the same one-way
// `@/lib/commcare` boundary too, but via `multimedia/assetWirePath`, not
// the validator. Both therefore carry their own file-specific entry in
// biome.json's allowlist (mirroring `!lib/media/manifest.ts`).

import "server-only";

import {
	isMediaValidationError,
	type ValidationError,
	validationError,
} from "@/lib/commcare/validator/errors";
import { runValidation } from "@/lib/commcare/validator/runner";
import { loadAssetsByIds, type MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
import {
	isMediaKind,
	MAX_MEDIA_EXPORT_ASSETS,
	MAX_MEDIA_EXPORT_BYTES,
} from "@/lib/domain/multimedia";

/**
 * Run media validation against a doc and return ONLY the media-category
 * errors — the actionable issues a media-ON expand would otherwise turn
 * into a `requireAssetRef` throw.
 *
 * The asset load here is INTENTIONALLY distinct from the manifest that
 * feeds `expandDoc`. `resolveMediaManifest` filters to `ready` rows (the
 * emitter can't bundle unvalidated bytes), but `loadAssetsByIds` returns
 * ready AND pending rows (owner-filtered). Pending rows must reach the
 * validator so `mediaAssetReady` can fire its "still uploading" message
 * rather than the manifest's `ready`-only view collapsing it into a
 * "not found" miss. This mirrors `validationLoop.ts::loadManifestForLoop`
 * exactly — two loads with different filters, one extra Firestore read
 * per upload/compile (the cost the SA path already pays).
 *
 * The full `runValidation` runs (with the manifest as
 * `RunValidationOptions.mediaAssets`), then the result is filtered to
 * the media category. Running full-then-filter — rather than a
 * media-rules-only subset run — is deliberate: `imageMapValueUnique`
 * lives in `MODULE_RULES`, not `MEDIA_ASSET_RULES`, so a subset run
 * would re-implement runner internals and drift. The filter keeps the
 * gate from newly blocking previously-working non-media uploads on
 * these entry points (they historically ran only schema parse, never
 * `runValidation`).
 *
 * Returns an empty array when the doc references no media — `runValidation`
 * still runs (cheap), but no media rule has anything to fire on.
 */
export async function collectMediaValidationErrors(
	doc: BlueprintDoc,
	owner: string,
): Promise<ValidationError[]> {
	const ids = [...collectAssetRefs(doc)];

	// Cap the reference COUNT before loading any rows. `loadAssetsByIds` issues
	// one Firestore batch read per 30 ids, so an unbounded reference set fans
	// out into many sequential round-trips before `exportBudgetError` (which
	// runs on the LOADED rows) can reject it — and this load runs twice per
	// request (here + `resolveMediaManifest`). The doc schema puts no ceiling
	// on field/option count, so a valid-parsing doc can carry an arbitrary
	// number of distinct refs; short-circuit here so the read fan-out is bounded
	// by the same export-asset limit the byte budget enforces downstream.
	if (ids.length > MAX_MEDIA_EXPORT_ASSETS) {
		return [
			validationError(
				"MEDIA_EXPORT_TOO_LARGE",
				"app",
				`This app references too many attachments to export — ${ids.length} (the limit is ${MAX_MEDIA_EXPORT_ASSETS}). Remove some attachments, then export again.`,
				{},
			),
		];
	}

	// Build the asset manifest the asset-context rules consume. An empty
	// map (no refs) still runs the media group — the rules produce zero
	// errors against zero refs, and `imageMapValueUnique` (manifest-
	// independent) runs regardless via `MODULE_RULES`.
	const rows = ids.length === 0 ? [] : await loadAssetsByIds(owner, ids);
	const mediaAssets = new Map(rows.map((row) => [row.id as string, row]));

	const errors = runValidation(doc, { mediaAssets });
	const mediaErrors = errors.filter(isMediaValidationError);

	// Append the aggregate export-budget error. It's computed from the row
	// sizes here rather than as a per-ref validator rule, because the limit
	// is a property of the SUM of referenced media (the in-memory manifest),
	// not of any single reference. Surfacing it through this gate puts it on
	// the same actionable-400 path as the per-ref media errors, and — since
	// this runs before `resolveMediaManifest` on every media-ON entry point
	// — it rejects an over-budget app before a single byte leaves GCS.
	const budgetError = exportBudgetError(rows);
	return budgetError ? [...mediaErrors, budgetError] : mediaErrors;
}

/**
 * Aggregate export-budget guard. The media-ON paths download every
 * referenced READY media asset's bytes into one in-memory manifest (the
 * `.ccz` ZIP buffer, the HQ per-file upload), so the work scales with the
 * SUM of referenced media — a total the per-asset size caps don't bound.
 * Sum the rows `resolveMediaManifest` will actually pull (ready + media
 * kind, mirroring its filter) and, if either the count or the total bytes
 * exceeds its ceiling, return the actionable error. Returns `null` when
 * the app is within budget.
 */
function exportBudgetError(rows: MediaAssetRecord[]): ValidationError | null {
	// Only ready media rows reach the byte download — the manifest filters
	// pending rows out, and documents never wire-emit — so the budget counts
	// exactly what would be loaded.
	const exportable = rows.filter(
		(row) => row.status === "ready" && isMediaKind(row.kind),
	);
	const totalBytes = exportable.reduce((sum, row) => sum + row.sizeBytes, 0);
	const overCount = exportable.length > MAX_MEDIA_EXPORT_ASSETS;
	const overBytes = totalBytes > MAX_MEDIA_EXPORT_BYTES;
	if (!overCount && !overBytes) return null;

	const capMb = Math.round(MAX_MEDIA_EXPORT_BYTES / 1024 / 1024);
	const reasons: string[] = [];
	if (overCount) {
		reasons.push(
			`${exportable.length} attachments (the limit is ${MAX_MEDIA_EXPORT_ASSETS})`,
		);
	}
	if (overBytes) {
		reasons.push(
			`${(totalBytes / 1024 / 1024).toFixed(0)} MB of media (the limit is ${capMb} MB)`,
		);
	}
	return validationError(
		"MEDIA_EXPORT_TOO_LARGE",
		"app",
		`This app bundles too much media to export — ${reasons.join(
			" and ",
		)}. Remove or shrink some attachments, then export again.`,
		{},
	);
}
