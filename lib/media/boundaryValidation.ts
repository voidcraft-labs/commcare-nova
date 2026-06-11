// lib/media/boundaryValidation.ts
//
// The transaction-boundary validity gate for every export entry point —
// the `.ccz` compile route/tool, the HQ-JSON export route, and the HQ
// upload route/tool. Each of those paths hands the app to something that
// can't ask follow-up questions (a device install, an HQ import), so the
// boundary is zero-tolerance: the full validator runs with the resolved
// asset manifest (`gate.ts::evaluateBoundary`) and ANY finding rejects
// the export with the rule's actionable message — soundness,
// completeness, and media-state alike. Commit-time gating keeps these
// findings rare; this gate is what makes "an invalid app never reaches
// CommCare HQ" hold even for docs persisted before the commit gates
// existed.
//
// It also owns the aggregate export budget: the media-ON paths load
// every referenced ready asset's bytes into one in-memory manifest, so
// the referenced-asset count and byte total are bounded HERE, before a
// single byte leaves GCS.
//
// Server-only: it reads Firestore (the owner's asset rows). It is the
// only media-side consumer of `lib/commcare/validator`; the manifest
// builder (`lib/media/manifest.ts`) crosses the same one-way
// `@/lib/commcare` boundary too, but via `multimedia/assetWirePath`, not
// the validator. Both therefore carry their own file-specific entry in
// biome.json's allowlist (mirroring `!lib/media/manifest.ts`).

import "server-only";

import {
	type ValidationError,
	validationError,
} from "@/lib/commcare/validator/errors";
import { evaluateBoundary } from "@/lib/commcare/validator/gate";
import { loadAssetsByIds, type MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
import {
	isMediaKind,
	MAX_MEDIA_EXPORT_ASSETS,
	MAX_MEDIA_EXPORT_BYTES,
} from "@/lib/domain/multimedia";

/**
 * Run the zero-tolerance boundary validation against a doc and return
 * every finding — the caller rejects the export when the list is
 * non-empty. There is no introduced-error allowance at a boundary: a
 * pre-existing problem in a legacy doc blocks its export exactly like a
 * fresh one, because the artifact would be broken either way.
 *
 * The asset load here is INTENTIONALLY distinct from the manifest that
 * feeds `expandDoc`. `resolveMediaManifest` filters to `ready` rows (the
 * emitter can't bundle unvalidated bytes), but `loadAssetsByIds` returns
 * ready AND pending rows (owner-filtered). Pending rows must reach the
 * validator so `mediaAssetReady` can fire its "still uploading" message
 * rather than the manifest's `ready`-only view collapsing it into a
 * "not found" miss. Two loads with different filters, one extra
 * Firestore read per upload/compile.
 *
 * Returns an empty array for a fully valid doc — the validator still
 * runs (cheap), and a media-free doc skips the Firestore read.
 */
export async function collectBoundaryViolations(
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
	// errors against zero refs.
	const rows = ids.length === 0 ? [] : await loadAssetsByIds(owner, ids);
	const mediaAssets = new Map(rows.map((row) => [row.id as string, row]));

	const errors = evaluateBoundary(doc, mediaAssets);

	// Append the aggregate export-budget error. It's computed from the row
	// sizes here rather than as a per-ref validator rule, because the limit
	// is a property of the SUM of referenced media (the in-memory manifest),
	// not of any single reference. Surfacing it through this gate puts it on
	// the same actionable-rejection path as every other boundary finding,
	// and — since this runs before `resolveMediaManifest` on every media-ON
	// entry point — it rejects an over-budget app before a single byte
	// leaves GCS.
	const budgetError = exportBudgetError(rows);
	return budgetError ? [...errors, budgetError] : errors;
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
