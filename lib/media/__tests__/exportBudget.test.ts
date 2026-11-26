/**
 * The in-memory export mode's ceiling math (`lib/export/boundaryValidation.ts`
 * without `streamMedia`, the one mode that holds every file at once). What
 * must hold:
 *
 *   1. Only READY rows of a media kind count — pending rows and
 *      documents are invisible to the budget, mirroring what the
 *      media-ON export actually loads.
 *   2. Count and byte ceilings each trip independently, and the
 *      reasons name the standing total against its limit.
 *
 * Pure module — no database, no React; nothing to stub.
 */

import { describe, expect, it } from "vitest";
import {
	MAX_MEDIA_EXPORT_ASSETS,
	MAX_MEDIA_EXPORT_BYTES,
} from "@/lib/domain/multimedia";
import { type ExportBudgetRowView, exportBudgetExcess } from "../exportBudget";

const MB = 1024 * 1024;

function row(
	overrides: Partial<ExportBudgetRowView> = {},
): ExportBudgetRowView {
	return { status: "ready", kind: "image", sizeBytes: 1 * MB, ...overrides };
}

describe("exportBudgetExcess", () => {
	it("accepts exactly the byte and asset limits", () => {
		expect(
			exportBudgetExcess([row({ sizeBytes: MAX_MEDIA_EXPORT_BYTES })]),
		).toBeNull();
		expect(
			exportBudgetExcess(
				Array.from({ length: MAX_MEDIA_EXPORT_ASSETS }, () =>
					row({ sizeBytes: 1 }),
				),
			),
		).toBeNull();
	});
	it("returns null within budget and counts only ready media rows", () => {
		expect(
			exportBudgetExcess([
				row(),
				row({ kind: "audio", sizeBytes: 5 * MB }),
				// Invisible to the budget: a pending upload and a document.
				row({ status: "pending", sizeBytes: 500 * MB }),
				row({ kind: "pdf", sizeBytes: 500 * MB }),
			]),
		).toBeNull();
	});

	it("trips on the byte ceiling and names the standing total", () => {
		const excess = exportBudgetExcess([
			row({ sizeBytes: MAX_MEDIA_EXPORT_BYTES }),
			row({ sizeBytes: 1 }),
		]);
		expect(excess).toMatchObject({
			exportableCount: 2,
			totalBytes: MAX_MEDIA_EXPORT_BYTES + 1,
		});
		expect(excess?.reasons).toHaveLength(1);
		expect(excess?.reasons[0]).toContain("MB of media");
		expect(excess?.reasons[0]).toContain("the limit is");
	});

	it("trips on the count ceiling", () => {
		const rows = Array.from({ length: MAX_MEDIA_EXPORT_ASSETS + 1 }, () =>
			row({ sizeBytes: 1 }),
		);
		const excess = exportBudgetExcess(rows);
		expect(excess).toMatchObject({
			exportableCount: MAX_MEDIA_EXPORT_ASSETS + 1,
			totalBytes: MAX_MEDIA_EXPORT_ASSETS + 1,
		});
		expect(excess?.reasons).toHaveLength(1);
		expect(excess?.reasons[0]).toContain(
			`${MAX_MEDIA_EXPORT_ASSETS + 1} attachments`,
		);
	});

	it("reports both reasons when both ceilings are breached", () => {
		const rows = Array.from({ length: MAX_MEDIA_EXPORT_ASSETS + 1 }, () =>
			row({ sizeBytes: MAX_MEDIA_EXPORT_BYTES }),
		);
		expect(exportBudgetExcess(rows)?.reasons).toHaveLength(2);
	});
});
