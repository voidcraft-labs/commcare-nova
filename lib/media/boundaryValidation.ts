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
// Division of labor with the at-source media verdict
// (`lib/media/attachVerdicts.ts`): every live attach already verified
// its asset (exists / owned / ready / kind-matched / inside the export
// budget) before committing, and an asset can't go bad after attach
// (deletion of a referenced asset is refused, `ready` is terminal,
// owner and kind are immutable — the verdict module's header carries
// the citations). So this gate's media arm is defense-in-depth: it
// catches references committed before the verdict existed (legacy
// docs) and ops disasters (a hand-deleted row, a reaped object) — the
// same role the rest of the boundary plays for the commit gate.
//
// It also owns the aggregate export budget: the media-ON paths load
// every referenced ready asset's bytes into one in-memory manifest, so
// the referenced-asset count and byte total are bounded HERE, before a
// single byte leaves GCS.
//
// Server-only: it reads Firestore (the project's asset rows). It is the
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
import { MAX_MEDIA_EXPORT_ASSETS } from "@/lib/domain/multimedia";
import { builtinAssetRows, partitionAssetRefs } from "./builtinIconAssets";
import { exportBudgetExcess } from "./exportBudget";

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
 * ready AND pending rows (project-filtered). Pending rows must reach the
 * validator so `mediaAssetReady` can fire its "still uploading" message
 * rather than the manifest's `ready`-only view collapsing it into a
 * "not found" miss. Two loads with different filters, one extra
 * Firestore read per upload/compile.
 *
 * Scope is the doc's referenced ids filtered to `projectId`: a
 * foreign-PROJECT reference loads no row, so it surfaces as
 * `MEDIA_ASSET_NOT_FOUND` — the cross-tenant defense, since media is
 * shared at the Project boundary.
 *
 * Returns an empty array for a fully valid doc — the validator still
 * runs (cheap), and a media-free doc skips the Firestore read.
 */
export async function collectBoundaryViolations(
	doc: BlueprintDoc,
	projectId: string,
): Promise<ValidationError[]> {
	const ids = [...collectAssetRefs(doc)];

	// Built-in icon refs (`nova-icon:<slug>`) carry no Firestore row — they
	// resolve from the shipped catalog + `public/nova-icons/` bytes. Partition
	// them off the Firestore load and synthesize ready/image rows so the media
	// rules + budget see them.
	const { realIds, builtinSlugs } = partitionAssetRefs(ids);

	// Cap the reference COUNT before loading any rows. `loadAssetsByIds` issues
	// one Firestore batch read per 30 ids, so an unbounded reference set fans
	// out into many sequential round-trips before `exportBudgetError` (which
	// runs on the LOADED rows) can reject it — and this load runs twice per
	// request (here + `resolveMediaManifest`). The doc schema puts no ceiling
	// on field/option count, so a valid-parsing doc can carry an arbitrary
	// number of distinct refs; short-circuit here so the read fan-out is bounded
	// by the same export-asset limit the byte budget enforces downstream. Built-ins
	// dedup to one wire entry per slug, so they count once each (not per ref).
	const exportableRefCount = realIds.length + builtinSlugs.length;
	if (exportableRefCount > MAX_MEDIA_EXPORT_ASSETS) {
		return [
			validationError(
				"MEDIA_EXPORT_TOO_LARGE",
				"app",
				`This app references too many attachments to export — ${exportableRefCount} (the limit is ${MAX_MEDIA_EXPORT_ASSETS}). Remove some attachments, then export again.`,
				{},
			),
		];
	}

	// Build the asset manifest the asset-context rules consume. An empty
	// map (no refs) still runs the media group — the rules produce zero
	// errors against zero refs.
	const realRows =
		realIds.length === 0 ? [] : await loadAssetsByIds(realIds, projectId);
	const rows = [...realRows, ...builtinAssetRows(builtinSlugs)];
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
 * The arithmetic is the shared ceiling math (`lib/media/exportBudget.ts`
 * — the attach-time checks, server tools and browser slots alike, run
 * the identical function; this boundary is the enforcement authority per
 * the trust model documented there). Returns `null` when the app is
 * within budget.
 */
function exportBudgetError(rows: MediaAssetRecord[]): ValidationError | null {
	const excess = exportBudgetExcess(rows);
	if (excess === null) return null;
	return validationError(
		"MEDIA_EXPORT_TOO_LARGE",
		"app",
		`This app bundles too much media to export — ${excess.reasons.join(
			" and ",
		)}. Remove or shrink some attachments, then export again.`,
		{},
	);
}
