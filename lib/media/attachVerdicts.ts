// lib/media/attachVerdicts.ts
//
// The at-source verdict for media ATTACH commits — the one judgment every
// doc-mutation media tool (`attach_field_media`, `attach_option_media`,
// `set_module_media`, `set_form_media`, `set_app_logo`) runs BEFORE its
// gated commit. An asset's lifecycle lives outside the doc (bytes in GCS,
// a Firestore status row), so no doc commit fires when it changes — which
// makes the attach the LAST commit that can see the asset's state. The
// verdict holds the line there: a committed media reference always points
// at an asset that exists, belongs to the app's owner, is `ready`, and
// matches its slot's kind — and the attach never pushes the app's
// referenced-media aggregate past the export ceiling.
//
// What makes checking at attach SUFFICIENT — an asset cannot go bad
// after the attach commits:
//
//   - Deleting a referenced asset is refused at both delete surfaces:
//     the browser route (`app/api/media/[assetId]/route.ts::DELETE`,
//     409) and the SA tool (`lib/agent/tools/media/removeMediaAsset.ts`)
//     both run `lib/media/assetDeletion.ts::findAppReferencesToAsset`
//     and refuse while any live app references the asset.
//   - `ready` is terminal: the only status writers are
//     `lib/db/mediaAssets.ts::createPendingAsset` (births `pending`) and
//     `lib/db/mediaAssets.ts::confirmAssetReady` (flips to `ready`);
//     nothing writes a status after that — a failed validation DELETES
//     the row instead of recording a state (see `MEDIA_ASSET_STATUSES`).
//   - `owner` is immutable: written once in `createPendingAsset`; no
//     update path carries it.
//   - `kind` is immutable: written once in `createPendingAsset`;
//     `confirmAssetReady` refines `mimeType`/`extension` but never
//     `kind`.
//
// The export boundary (`lib/media/boundaryValidation.ts`) keeps running
// the same media rules with a freshly resolved manifest — as
// defense-in-depth for refs committed before this verdict existed and
// for ops disasters (a hand-deleted row, a reaped object), not as the
// live surface's gate.
//
// Surfaces: chat runs the verdict as a pre-commit read (the run owns its
// doc between the read and the fire-and-forget save). MCP re-runs the
// per-asset judgment INSIDE the transactional commit — the expectations
// ride `guardedMutate` → `recordMutations` → `applyBlueprintChange`'s
// guard, and `describeMediaExpectationFailures` is re-applied to rows
// read in the SAME Firestore transaction that re-verdicts the batch, so
// a delete racing the attach serializes against it. The aggregate
// ceiling stays pre-commit-only on both surfaces: a racing delete can
// only SHRINK the aggregate, and the boundary's own budget check remains
// the backstop for the pathological concurrent-attach case.

import { loadAssetsByIds, type MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
import {
	type AssetKind,
	isMediaKind,
	MAX_MEDIA_EXPORT_ASSETS,
	MAX_MEDIA_EXPORT_BYTES,
	type MediaKind,
} from "@/lib/domain/multimedia";

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
	"owner" | "status" | "kind"
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
 * A row owned by someone else reads as "not in your library" — the same
 * message as a deleted asset — so a guessed id can't probe whether
 * another user's asset exists (mirrors `loadAssetsByIds`'s silent
 * owner filter).
 */
export function describeMediaExpectationFailures(
	expectations: readonly MediaAttachExpectation[],
	rows: ReadonlyMap<string, MediaExpectationRow>,
	owner: string,
): string | null {
	const failures: string[] = [];
	for (const expectation of expectations) {
		const row = rows.get(expectation.assetId);
		if (!row || row.owner !== owner) {
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
 * ids) in one owner-filtered batch, run the per-asset judgment over the
 * expectations, then hold the post-attach aggregate of referenced READY
 * media inside the export ceiling — the same `MAX_MEDIA_EXPORT_ASSETS` /
 * `MAX_MEDIA_EXPORT_BYTES` budget `boundaryValidation.ts` enforces at
 * export, applied here so the user hears "remove other media first" at
 * the attach instead of at the export door.
 *
 * The aggregate counts a ref being REPLACED in the same batch (the old
 * value still sits on the pre-attach doc) — a one-asset overcount at the
 * exact ceiling, accepted because it only ever errs toward rejecting,
 * never toward letting an over-budget app through.
 *
 * `doc` is the PRE-attach doc; callers pass the expectations for every
 * slot the call SETS (clears carry no expectation and need no verdict).
 */
export async function mediaAttachVerdict(args: {
	owner: string;
	doc: BlueprintDoc;
	expectations: readonly MediaAttachExpectation[];
}): Promise<MediaAttachVerdict> {
	const { owner, doc, expectations } = args;
	if (expectations.length === 0) return { ok: true };

	const ids = [
		...new Set([
			...collectAssetRefs(doc),
			...expectations.map((e) => e.assetId),
		]),
	];
	const rows = await loadAssetsByIds(owner, ids);
	const rowsById = new Map<string, MediaAssetRecord>(
		rows.map((row) => [row.id as string, row]),
	);

	const failure = describeMediaExpectationFailures(
		expectations,
		rowsById,
		owner,
	);
	if (failure) return { ok: false, error: failure };

	// Post-attach aggregate, mirroring the boundary's `exportBudgetError`
	// filter: only ready media rows reach the export byte download, so
	// only those count against the ceiling.
	const exportable = rows.filter(
		(row) => row.status === "ready" && isMediaKind(row.kind),
	);
	const totalBytes = exportable.reduce((sum, row) => sum + row.sizeBytes, 0);
	const overCount = exportable.length > MAX_MEDIA_EXPORT_ASSETS;
	const overBytes = totalBytes > MAX_MEDIA_EXPORT_BYTES;
	if (overCount || overBytes) {
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
		return {
			ok: false,
			error: `Attaching this would put the app over its media export limit — ${reasons.join(
				" and ",
			)}. Remove or shrink some other attachments first, then attach this one.`,
		};
	}

	return { ok: true };
}
