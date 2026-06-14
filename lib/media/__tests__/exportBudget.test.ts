/**
 * The shared export-ceiling math — one source, three consumers (the
 * export boundary, the SA/MCP attach verdict, the browser attach
 * check). What must hold:
 *
 *   1. Only READY rows of a media kind count — pending rows and
 *      documents are invisible to the budget, mirroring what the
 *      media-ON export actually loads.
 *   2. Count and byte ceilings each trip independently, and the
 *      reasons name the standing total against its limit.
 *   3. `postAttachBudgetError` — the browser check's pure core —
 *      composes referenced rows with the candidate: unknown refs
 *      contribute nothing, a same-id candidate isn't double-counted,
 *      an in-budget attach returns null, an over-budget one returns
 *      the shared prose.
 *
 * Pure module — no Firestore, no React; nothing to stub.
 */

import { describe, expect, it } from "vitest";
import {
	MAX_MEDIA_EXPORT_ASSETS,
	MAX_MEDIA_EXPORT_BYTES,
} from "@/lib/domain/multimedia";
import {
	attachOverBudgetMessage,
	type ExportBudgetRowView,
	exportBudgetExcess,
	postAttachBudgetError,
} from "../exportBudget";

const MB = 1024 * 1024;

function row(
	overrides: Partial<ExportBudgetRowView> = {},
): ExportBudgetRowView {
	return { status: "ready", kind: "image", sizeBytes: 1 * MB, ...overrides };
}

describe("exportBudgetExcess", () => {
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
			row({ sizeBytes: 1 * MB }),
		]);
		expect(excess).not.toBeNull();
		expect(excess?.reasons).toHaveLength(1);
		expect(excess?.reasons[0]).toContain("MB of media");
		expect(excess?.reasons[0]).toContain("the limit is");
	});

	it("trips on the count ceiling", () => {
		const rows = Array.from({ length: MAX_MEDIA_EXPORT_ASSETS + 1 }, () =>
			row({ sizeBytes: 1 }),
		);
		const excess = exportBudgetExcess(rows);
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

describe("attachOverBudgetMessage", () => {
	it("speaks the what/where/what-to-do prose", () => {
		const message = attachOverBudgetMessage({
			exportableCount: 3,
			totalBytes: 201 * MB,
			reasons: ["201 MB of media (the limit is 200 MB)"],
		});
		expect(message).toContain("Attaching this would put the app over");
		expect(message).toContain("201 MB of media (the limit is 200 MB)");
		expect(message).toContain("Remove or shrink some other attachments");
	});
});

describe("postAttachBudgetError", () => {
	it("returns null when the attach fits", () => {
		const error = postAttachBudgetError({
			referencedIds: ["a", "b"],
			rowsById: new Map([
				["a", row({ sizeBytes: 10 * MB })],
				["b", row({ sizeBytes: 10 * MB })],
			]),
			candidate: { id: "c", ...row({ sizeBytes: 10 * MB }) },
		});
		expect(error).toBeNull();
	});

	it("rejects when the candidate pushes the referenced bytes over", () => {
		const error = postAttachBudgetError({
			referencedIds: ["a"],
			rowsById: new Map([["a", row({ sizeBytes: 150 * MB })]]),
			candidate: { id: "c", ...row({ sizeBytes: 60 * MB }) },
		});
		expect(error).toContain("media export limit");
		expect(error).toContain("MB of media");
	});

	it("treats an unknown referenced id as absent (matching the server's owner-filtered load)", () => {
		const error = postAttachBudgetError({
			referencedIds: ["gone-1", "gone-2"],
			rowsById: new Map(),
			candidate: { id: "c", ...row({ sizeBytes: 10 * MB }) },
		});
		expect(error).toBeNull();
	});

	it("does not double-count a candidate already referenced under the same id", () => {
		// 150 MB referenced + re-attaching the SAME 150 MB asset elsewhere:
		// one asset, one set of bytes — under budget.
		const error = postAttachBudgetError({
			referencedIds: ["a"],
			rowsById: new Map([["a", row({ sizeBytes: 150 * MB })]]),
			candidate: { id: "a", ...row({ sizeBytes: 150 * MB }) },
		});
		expect(error).toBeNull();
	});
});
