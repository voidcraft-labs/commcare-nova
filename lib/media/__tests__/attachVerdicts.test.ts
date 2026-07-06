/**
 * Behavioral tests for the media attach verdict — the at-source judgment
 * every doc-mutation media tool runs before its gated commit.
 *
 * Coverage:
 *   1. A ready, owned, kind-matched asset passes.
 *   2. Missing / foreign / pending / kind-mismatched assets fail with
 *      their own person-to-person line (foreign reads as missing —
 *      privacy).
 *   3. Several failures report together, one line each.
 *   4. The aggregate export ceiling rejects on count and on bytes,
 *      counting the doc's EXISTING refs alongside the new ones.
 *   5. Zero expectations short-circuit — the asset table is never read
 *      (clears stay free).
 *
 * `@/lib/db/mediaAssets` is stubbed at the import boundary (the real
 * module reaches Firestore); the mock serves rows from a per-test map.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import { asAssetId } from "@/lib/domain/multimedia";
import {
	describeMediaExpectationFailures,
	type MediaAttachExpectation,
	type MediaExpectationRow,
	mediaAttachVerdict,
} from "../attachVerdicts";

interface MockRow {
	id: string;
	project_id: string;
	status: "pending" | "ready";
	kind: string;
	sizeBytes: number;
}

const { rows, loadAssetsByIdsMock } = vi.hoisted(() => {
	const rows = new Map<string, MockRow>();
	return {
		rows,
		loadAssetsByIdsMock: vi.fn(
			async (ids: readonly string[], projectId: string) =>
				[...new Set(ids)]
					.map((id) => rows.get(id))
					.filter(
						(row): row is MockRow =>
							row !== undefined && row.project_id === projectId,
					),
		),
	};
});

vi.mock("@/lib/db/mediaAssets", () => ({
	loadAssetsByIds: loadAssetsByIdsMock,
}));

function seed(id: string, overrides: Partial<Omit<MockRow, "id">> = {}): void {
	rows.set(id, {
		id,
		project_id: "project-1",
		status: "ready",
		kind: "image",
		sizeBytes: 1024,
		...overrides,
	});
}

/** Empty doc — no existing refs. */
function emptyDoc(): BlueprintDoc {
	return {
		appId: "app-1",
		appName: "App",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

function imageExpectation(assetId: string): MediaAttachExpectation {
	return { assetId, kind: "image", slot: "the app logo" };
}

beforeEach(() => {
	vi.clearAllMocks();
	rows.clear();
});

describe("mediaAttachVerdict", () => {
	it("passes a ready, owned, kind-matched asset", async () => {
		seed("a1");
		const verdict = await mediaAttachVerdict({
			projectId: "project-1",
			doc: emptyDoc(),
			expectations: [imageExpectation("a1")],
		});
		expect(verdict).toEqual({ ok: true });
	});

	it("fails a missing asset, pointing at the slot and the library", async () => {
		const verdict = await mediaAttachVerdict({
			projectId: "project-1",
			doc: emptyDoc(),
			expectations: [imageExpectation("a-gone")],
		});
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.error).toContain("a-gone");
		expect(verdict.error).toContain("the app logo");
		expect(verdict.error).toContain("library");
	});

	it("reads a foreign-Project asset as missing (no cross-tenant leak)", async () => {
		seed("a-foreign", { project_id: "project-2" });
		const verdict = await mediaAttachVerdict({
			projectId: "project-1",
			doc: emptyDoc(),
			expectations: [imageExpectation("a-foreign")],
		});
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.error).toContain("library");
		expect(verdict.error).not.toContain("project-2");
		expect(verdict.error).not.toMatch(/own|belong/i);
	});

	it("fails a pending asset with the still-uploading message", async () => {
		seed("a-pending", { status: "pending" });
		const verdict = await mediaAttachVerdict({
			projectId: "project-1",
			doc: emptyDoc(),
			expectations: [imageExpectation("a-pending")],
		});
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.error).toContain("upload hasn't finished");
	});

	it("fails a kind mismatch naming both kinds", async () => {
		seed("a-audio", { kind: "audio" });
		const verdict = await mediaAttachVerdict({
			projectId: "project-1",
			doc: emptyDoc(),
			expectations: [imageExpectation("a-audio")],
		});
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.error).toContain("an audio file");
		expect(verdict.error).toContain("an image");
	});

	it("rejects when the attach would push the byte aggregate past the export ceiling", async () => {
		// One ready row whose recorded size alone exceeds the 200 MB budget.
		seed("a-huge", { sizeBytes: 201 * 1024 * 1024 });
		const verdict = await mediaAttachVerdict({
			projectId: "project-1",
			doc: emptyDoc(),
			expectations: [imageExpectation("a-huge")],
		});
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.error).toContain("export limit");
		expect(verdict.error).toContain("MB");
	});

	it("rejects when the attach would push the COUNT aggregate past the export ceiling", async () => {
		const expectations: MediaAttachExpectation[] = [];
		for (let i = 0; i < 501; i++) {
			const id = `a-${i}`;
			seed(id);
			expectations.push(imageExpectation(id));
		}
		const verdict = await mediaAttachVerdict({
			projectId: "project-1",
			doc: emptyDoc(),
			expectations,
		});
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.error).toContain("501 attachments");
	});

	it("counts the doc's EXISTING ready refs against the ceiling", async () => {
		seed("a-existing", { sizeBytes: 150 * 1024 * 1024 });
		seed("a-new", { sizeBytes: 60 * 1024 * 1024 });
		const doc = emptyDoc();
		doc.logo = asAssetId("a-existing");
		const verdict = await mediaAttachVerdict({
			projectId: "project-1",
			doc,
			// The new ref alone is under budget; existing + new is over.
			expectations: [
				{ assetId: "a-new", kind: "image", slot: 'the icon on module "M"' },
			],
		});
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.error).toContain("export limit");
	});

	it("short-circuits on zero expectations without reading the asset table", async () => {
		const verdict = await mediaAttachVerdict({
			projectId: "project-1",
			doc: emptyDoc(),
			expectations: [],
		});
		expect(verdict).toEqual({ ok: true });
		expect(loadAssetsByIdsMock).not.toHaveBeenCalled();
	});
});

describe("describeMediaExpectationFailures", () => {
	it("reports every failed expectation, one line each, and null when all hold", () => {
		const table = new Map<string, MediaExpectationRow>([
			["ok", { project_id: "project-1", status: "ready", kind: "image" }],
			[
				"pending",
				{ project_id: "project-1", status: "pending", kind: "image" },
			],
			[
				"wrong-kind",
				{ project_id: "project-1", status: "ready", kind: "video" },
			],
		]);
		const failures = describeMediaExpectationFailures(
			[
				{ assetId: "ok", kind: "image", slot: "slot A" },
				{ assetId: "pending", kind: "image", slot: "slot B" },
				{ assetId: "wrong-kind", kind: "image", slot: "slot C" },
				{ assetId: "absent", kind: "image", slot: "slot D" },
			],
			table,
			"project-1",
		);
		expect(failures).not.toBeNull();
		const lines = (failures ?? "").split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("slot B");
		expect(lines[1]).toContain("slot C");
		expect(lines[2]).toContain("slot D");

		expect(
			describeMediaExpectationFailures(
				[{ assetId: "ok", kind: "image", slot: "slot A" }],
				table,
				"project-1",
			),
		).toBeNull();
	});
});
