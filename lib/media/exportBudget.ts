// lib/media/exportBudget.ts
//
// The media budget of the one export mode that holds every referenced
// ready asset's bytes in memory at once: `lib/export/boundaryValidation.ts`
// run without `streamMedia`, whose aggregate check refuses an app past
// `MAX_MEDIA_EXPORT_ASSETS` / `MAX_MEDIA_EXPORT_BYTES` before a byte is
// fetched. Every production export (the `.ccz`, the HQ JSON package, the HQ
// upload and the next publish's body a bring-in of HQ changes computes)
// streams its media one file at a time and holds no such total, so an app
// holds any number of files and no attach is refused for its total.
//
// Client-safe by construction: imports only `lib/domain`.

import {
	type AssetKind,
	isMediaKind,
	MAX_MEDIA_EXPORT_ASSETS,
	MAX_MEDIA_EXPORT_BYTES,
} from "@/lib/domain/multimedia";

/**
 * The row fields the budget reads, structurally satisfied by the Postgres
 * `MediaAssetRecord`. `status` is widened to `string`; only `"ready"`
 * counts.
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
	/** Person-readable over-budget reasons, one per breached limit, which the
	 *  boundary's refusal names. */
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
