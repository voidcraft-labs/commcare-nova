// lib/media/exportBudget.ts
//
// The ONE source for the media export-ceiling arithmetic. The media-ON
// export paths load every referenced ready asset's bytes into memory at
// once, so the budget is a property of the SUM of an app's referenced
// ready media (`MAX_MEDIA_EXPORT_ASSETS` / `MAX_MEDIA_EXPORT_BYTES`) —
// and three surfaces hold the same line with this module's math:
//
//   - `lib/export/boundaryValidation.ts` — the export boundary's
//     aggregate check, run on every compile/upload entry point.
//   - `lib/media/attachVerdicts.ts` — the SA/MCP attach verdict, so an
//     over-budget attach is refused at the tool call.
//   - `components/builder/media/useAttachBudget.ts` — the browser
//     slots' pre-dispatch check, so an over-budget attach is refused at
//     the click.
//
// Trust model: the BOUNDARY is the enforcement authority — it runs
// server-side against freshly loaded rows on every export, so nothing a
// client does (a hand-rolled request, a tampered bundle, a stale row
// snapshot) gets an over-budget app onto a device or HQ. The attach-time
// checks are the honest-user UX guarantee: they make "learn at export"
// unreachable for anyone using the real surfaces, but they are
// advisory, not load-bearing — the browser check in particular computes
// against client-known rows and FAILS OPEN on a metadata fetch it can't
// complete, because refusing a legitimate attach over a transient fetch
// is worse than letting the boundary do its job.
//
// Client-safe by construction: imports only `lib/domain` (no `lib/db`,
// no server-only), so the browser hook and the server modules consume
// the identical function.

import {
	type AssetKind,
	isMediaKind,
	MAX_MEDIA_EXPORT_ASSETS,
	MAX_MEDIA_EXPORT_BYTES,
} from "@/lib/domain/multimedia";

/**
 * The row fields the budget reads — structurally satisfied by the
 * Postgres `MediaAssetRecord` (server) and the wire `WireMediaAsset`
 * (browser), so every consumer passes its native shape.
 *
 * `status` is widened to `string`: the server record types it as the
 * literal union, the wire shape the same, and the browser registry
 * stores whatever the wire said — only `"ready"` counts either way.
 */
export interface ExportBudgetRowView {
	status: string;
	kind: AssetKind;
	sizeBytes: number;
}

/** How far over the ceiling an app's referenced media stands. */
export interface ExportBudgetExcess {
	/** The rows the media-ON export would load (ready + media kind). */
	exportableCount: number;
	totalBytes: number;
	/** Person-readable over-budget reasons — one per breached limit,
	 *  shared verbatim by every surface's rejection message. */
	reasons: string[];
}

/**
 * Sum the rows the media-ON export would actually load — ready rows of
 * a wire-attachable media kind, mirroring `resolveMediaManifest`'s
 * filter (pending rows never download; documents never wire-emit) — and
 * report the excess, or `null` when the set is within budget.
 */
export function exportBudgetExcess(
	rows: readonly ExportBudgetRowView[],
): ExportBudgetExcess | null {
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
	return { exportableCount: exportable.length, totalBytes, reasons };
}

/**
 * The attach-time rejection prose — what was tried, where the budget
 * stands, what to do. Shared by the SA/MCP verdict and the browser
 * check so the two surfaces speak identically.
 */
export function attachOverBudgetMessage(excess: ExportBudgetExcess): string {
	return `Attaching this would put the app over its media export limit — ${excess.reasons.join(
		" and ",
	)}. Remove or shrink some other attachments first, then attach this one.`;
}

/**
 * The browser attach check's pure core: would attaching `candidate` to
 * a doc referencing `referencedIds` breach the export ceiling? Resolves
 * each referenced id against `rowsById` (the client's known asset
 * metadata — loaded library pages plus any rows fetched for the check);
 * an id with no known row contributes nothing, matching the server
 * verdict's owner-filtered load where a deleted/foreign ref reads as
 * absent. The candidate replaces any same-id entry, so re-attaching an
 * already-referenced asset isn't double-counted; a REPLACED ref's old
 * asset still counts (it sits on the pre-attach doc), the same one-row
 * conservatism the server verdict documents.
 *
 * Returns the shared rejection prose, or `null` when the attach fits.
 */
export function postAttachBudgetError(args: {
	referencedIds: Iterable<string>;
	rowsById: ReadonlyMap<string, ExportBudgetRowView>;
	candidate: { id: string } & ExportBudgetRowView;
}): string | null {
	const byId = new Map<string, ExportBudgetRowView>();
	for (const id of args.referencedIds) {
		const row = args.rowsById.get(id);
		if (row) byId.set(id, row);
	}
	const { id, ...candidateRow } = args.candidate;
	byId.set(id, candidateRow);
	const excess = exportBudgetExcess([...byId.values()]);
	return excess === null ? null : attachOverBudgetMessage(excess);
}
