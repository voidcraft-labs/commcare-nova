// lib/media/attachVerdicts.ts
//
// The at-source verdict for media ATTACH commits — the one judgment every
// doc-mutation media tool (`attach_field_media`, `attach_option_media`,
// `set_menu_media`, `set_app_logo`) runs BEFORE its
// gated commit. An asset's lifecycle lives outside the doc (bytes in GCS,
// a Postgres status row), so no doc commit fires when it changes — which
// makes the attach the LAST commit that can see the asset's state. The
// verdict holds the line there: a committed media reference always points
// at an asset that exists, belongs to the app's Project, is `ready`, and
// matches its slot's kind — and the attach never pushes the app's
// referenced-media aggregate past the export ceiling.
//
// Why attach-time checking holds:
//
//   - Every authoritative app writer locks newly introduced asset rows
//     `FOR SHARE`, rechecks Project/readiness, and inserts reverse edges
//     in the SAME transaction as the blueprint/thread commit. Deletion
//     takes the conflicting asset `FOR UPDATE` lock and then coherently
//     re-walks persisted carriers. Attach-first therefore makes deletion
//     refuse; delete-first makes the waiting attach reject the missing row.
//     `findAppReferencesToAsset` is only an actionable UX preflight.
//   - `ready` is terminal: the only status writers are
//     `lib/db/mediaAssets.ts::createPendingAsset` (births `pending`) and
//     `lib/db/mediaAssets.ts::confirmAssetReady` (flips to `ready`);
//     nothing writes a status after that — a failed validation DELETES
//     the row instead of recording a state (see `MEDIA_ASSET_STATUSES`).
//   - `project_id` is immutable: written once in `createPendingAsset` as
//     the asset's tenant; no update path carries it.
//   - `kind` is immutable: written once in `createPendingAsset`;
//     `confirmAssetReady` refines `mimeType`/`extension` but never
//     `kind`.
//
// The export boundary (`lib/export/boundaryValidation.ts`) keeps running
// the same media rules with a freshly resolved manifest — as
// defense-in-depth for refs committed before this verdict existed and
// for ops disasters (a hand-deleted row, a reaped object), not as the
// live surface's gate.
//
// Surfaces: chat and MCP both feed their expectations into the authoritative
// transactional writer; this preflight exists for early, specific feedback,
// never as the concurrency boundary. The aggregate ceiling stays
// pre-commit-only: a racing delete can only SHRINK the aggregate, and the
// boundary's own budget check remains defense in depth for pathological
// concurrent attaches.

import { loadAssetsByIds, type MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
import type { AssetKind, MediaKind } from "@/lib/domain/multimedia";
import { attachOverBudgetMessage, exportBudgetExcess } from "./exportBudget";

/**
 * One asset reference an attach is about to commit: the id the caller
 * supplied, the kind the target slot requires, and the authoring-layer
 * phrase naming the slot (`the image on the label media of field "x"`)
 * the rejection message points at.
 */
export interface MediaAttachExpectation {
	readonly assetId: string;
	readonly kind: MediaKind;
	readonly slot: string;
}

/** Outcome of {@link mediaAttachVerdict}. A failure's `error` is the
 *  person-to-person message the tool returns in its `{ error }` envelope —
 *  one line per failed expectation. */
export type MediaAttachVerdict = { ok: true } | { ok: false; error: string };

/** The row fields the per-asset judgment reads — a subset of
 *  `MediaAssetRecord` so the MCP transactional re-check and the
 *  pre-commit verdict consume the same shape. */
export type MediaExpectationRow = Pick<
	MediaAssetRecord,
	"project_id" | "status" | "kind"
>;

/** "an image" / "an audio file" / "a video" / "a pdf document" — the
 *  noun phrase rejection messages use for an asset kind. */
function kindPhrase(kind: AssetKind): string {
	switch (kind) {
		case "image":
			return "an image";
		case "audio":
			return "an audio file";
		case "video":
			return "a video";
		default:
			return `a ${kind} document`;
	}
}

/**
 * The per-asset judgment — pure, shared verbatim by the pre-commit
 * verdict and the MCP transactional re-check so the two cannot drift on
 * what "good" means. Returns `null` when every expectation holds, or the
 * combined person-to-person failure message (one line per failure).
 *
 * A row in another Project reads as "not in your library" — the same
 * message as a deleted asset — so a guessed id can't probe whether
 * another Project's asset exists (mirrors `loadAssetsByIds`'s silent
 * project filter).
 */
export function describeMediaExpectationFailures(
	expectations: readonly MediaAttachExpectation[],
	rows: ReadonlyMap<string, MediaExpectationRow>,
	projectId: string,
): string | null {
	const failures: string[] = [];
	for (const expectation of expectations) {
		const row = rows.get(expectation.assetId);
		if (!row || row.project_id !== projectId) {
			failures.push(
				`Tried to attach asset "${expectation.assetId}" as ${expectation.slot}, but no asset with that id is in your library — it may have been deleted, or the id may be mistyped. Run list_media_assets to see what's available, or upload the file first.`,
			);
			continue;
		}
		if (row.status !== "ready") {
			failures.push(
				`Tried to attach asset "${expectation.assetId}" as ${expectation.slot}, but its upload hasn't finished — the bytes aren't confirmed yet. Wait for it to appear in list_media_assets (only ready assets are listed), or pick a different file.`,
			);
			continue;
		}
		if (row.kind !== expectation.kind) {
			failures.push(
				`Tried to attach asset "${expectation.assetId}" as ${expectation.slot}, but that asset is ${kindPhrase(row.kind)} and this slot takes ${kindPhrase(expectation.kind)}. Pick ${kindPhrase(expectation.kind)} from list_media_assets instead.`,
			);
		}
	}
	return failures.length > 0 ? failures.join("\n") : null;
}

/**
 * The full pre-commit verdict: load the rows for everything the doc
 * would reference after the attach (current refs ∪ the expectations'
 * ids) in one Project-filtered batch, run the per-asset judgment over the
 * expectations, then hold the post-attach aggregate of referenced READY
 * media inside the export ceiling — the same `MAX_MEDIA_EXPORT_ASSETS` /
 * `MAX_MEDIA_EXPORT_BYTES` budget `lib/export/boundaryValidation.ts` enforces at
 * export, applied here so the user hears "remove other media first" at
 * the attach instead of at the export door.
 *
 * The aggregate counts every ref being REPLACED in the same batch (the
 * old values still sit on the pre-attach doc) — an overcount of up to
 * one asset per replaced slot, so a batch tool swapping many uploaded
 * refs on an app at the exact ceiling can be over-rejected. Accepted
 * because it only ever errs toward rejecting, never toward letting an
 * over-budget app through; the SA recovers by clearing or splitting the
 * replacement.
 *
 * `doc` is the PRE-attach doc; callers pass the expectations for every
 * slot the call SETS (clears carry no expectation and need no verdict).
 */
export async function mediaAttachVerdict(args: {
	projectId: string;
	doc: BlueprintDoc;
	expectations: readonly MediaAttachExpectation[];
}): Promise<MediaAttachVerdict> {
	const { projectId, doc, expectations } = args;
	if (expectations.length === 0) return { ok: true };

	const ids = [
		...new Set([
			...collectAssetRefs(doc),
			...expectations.map((e) => e.assetId),
		]),
	];
	const rows = await loadAssetsByIds(ids, projectId);
	const rowsById = new Map<string, MediaAssetRecord>(
		rows.map((row) => [row.id as string, row]),
	);

	const failure = describeMediaExpectationFailures(
		expectations,
		rowsById,
		projectId,
	);
	if (failure) return { ok: false, error: failure };

	// Post-attach aggregate — the shared ceiling math
	// (`lib/media/exportBudget.ts`), the same function the export
	// boundary and the browser slots run.
	const excess = exportBudgetExcess(rows);
	if (excess !== null) {
		return { ok: false, error: attachOverBudgetMessage(excess) };
	}

	return { ok: true };
}
