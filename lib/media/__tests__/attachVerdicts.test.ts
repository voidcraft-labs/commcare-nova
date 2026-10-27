/**
 * Behavioral tests for the media attach verdict — the at-source judgment
 * every doc-mutation media tool runs before its gated commit.
 *
 * Coverage:
 *   1. A ready, same-Project, kind-matched asset passes.
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
 * module reaches Postgres); the mock serves rows from a per-test map.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import type { BlueprintDoc } from "@/lib/domain";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import {
	describeMediaExpectationFailures,
	type MediaAttachExpectation,
	type MediaExpectationRow,
	mediaAttachVerdict,
} from "../attachVerdicts";

interface MockRow {
	id: MediaAssetId;
	project_id: string;
	status: "pending" | "ready";
	kind: string;
	mimeType: string;
	mediaFormat?: string;
	sizeBytes: number;
}

const { rows, loadAssetsByIdsMock } = vi.hoisted(() => {
	const rows = new Map<MediaAssetId, MockRow>();
	return {
		rows,
		loadAssetsByIdsMock: vi.fn(
			async (ids: readonly MediaAssetId[], projectId: string) =>
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

function seed(
	id: MediaAssetId,
	overrides: Partial<Omit<MockRow, "id">> = {},
): void {
	rows.set(id, {
		id,
		project_id: "project-1",
		status: "ready",
		kind: "image",
		mimeType: "image/png",
		mediaFormat: "png",
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
		appSettings: { showSavedForms: false, showIncompleteForms: false },
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

function imageExpectation(assetId: MediaAssetId): MediaAttachExpectation {
	return { assetId, kind: "image", slot: "the app logo" };
}

beforeEach(() => {
	rows.clear();
});

describe("mediaAttachVerdict", () => {
	it("passes a ready, same-Project, kind-matched asset", async () => {
		seed(testMediaAssetId("a1"));
		const verdict = await mediaAttachVerdict({
			projectId: "project-1",
			doc: emptyDoc(),
			expectations: [imageExpectation(testMediaAssetId("a1"))],
		});
		expect(verdict).toEqual({ ok: true });
		expect(loadAssetsByIdsMock).toHaveBeenCalledWith(
			[testMediaAssetId("a1")],
			"project-1",
		);
	});

	it("fails a missing asset, pointing at the slot and the library", async () => {
		const verdict = await mediaAttachVerdict({
			projectId: "project-1",
			doc: emptyDoc(),
			expectations: [imageExpectation(testMediaAssetId("a-gone"))],
		});
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.error).toContain(testMediaAssetId("a-gone"));
		expect(verdict.error).toContain("the app logo");
		expect(verdict.error).toContain("library");
	});

	it("reads a foreign-Project asset as missing (no cross-tenant leak)", async () => {
		seed(testMediaAssetId("a-foreign"), { project_id: "project-2" });
		const verdict = await mediaAttachVerdict({
			projectId: "project-1",
			doc: emptyDoc(),
			expectations: [imageExpectation(testMediaAssetId("a-foreign"))],
		});
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.error).toContain("library");
		expect(verdict.error).not.toContain("project-2");
		rows.delete(testMediaAssetId("a-foreign"));
		const missing = await mediaAttachVerdict({
			projectId: "project-1",
			doc: emptyDoc(),
			expectations: [imageExpectation(testMediaAssetId("a-foreign"))],
		});
		expect(missing).toEqual(verdict);
	});

	it("fails a pending asset with the still-uploading message", async () => {
		seed(testMediaAssetId("a-pending"), { status: "pending" });
		const verdict = await mediaAttachVerdict({
			projectId: "project-1",
			doc: emptyDoc(),
			expectations: [imageExpectation(testMediaAssetId("a-pending"))],
		});
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.error).toContain("upload hasn't finished");
	});

	it("fails a kind mismatch naming both kinds", async () => {
		seed(testMediaAssetId("a-audio"), {
			kind: "audio",
			mimeType: "audio/mpeg",
			mediaFormat: "mp3",
		});
		const verdict = await mediaAttachVerdict({
			projectId: "project-1",
			doc: emptyDoc(),
			expectations: [imageExpectation(testMediaAssetId("a-audio"))],
		});
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.error).toContain("an audio file");
		expect(verdict.error).toContain("an image");
	});

	it("refuses a file a declared platform can't play, naming the format and the platform", async () => {
		seed(testMediaAssetId("a-hevc"), {
			kind: "video",
			mimeType: "video/mp4",
			mediaFormat: "mp4-hevc",
		});
		const hevc = await mediaAttachVerdict({
			projectId: "project-1",
			doc: emptyDoc(),
			expectations: [
				{
					assetId: testMediaAssetId("a-hevc"),
					kind: "video",
					slot: 'the video on field "intro"',
				},
			],
		});
		expect(hevc).toEqual({
			ok: false,
			error: `Tried to attach asset "${testMediaAssetId("a-hevc")}" as the video on field "intro", but it is MP4 (HEVC), which Web Apps can't play, and this app runs in Web Apps. Exporting it again as MP4 with H.264 Main video and uploading that fixes it.`,
		});

		seed(testMediaAssetId("a-ico"), {
			mimeType: "image/vnd.microsoft.icon",
			mediaFormat: "ico",
		});
		const androidOnly = emptyDoc();
		androidOnly.appSettings = {
			...androidOnly.appSettings,
			runsOnlyOn: "android",
		};
		const ico = await mediaAttachVerdict({
			projectId: "project-1",
			doc: androidOnly,
			expectations: [imageExpectation(testMediaAssetId("a-ico"))],
		});
		expect(ico).toEqual({
			ok: false,
			error: `Tried to attach asset "${testMediaAssetId("a-ico")}" as the app logo, but it is ICO, which Android can't play, and this app runs on Android. Exporting it again as a PNG or JPEG and uploading that fixes it.`,
		});
		expect(
			await mediaAttachVerdict({
				projectId: "project-1",
				doc: {
					...androidOnly,
					appSettings: { ...androidOnly.appSettings, runsOnlyOn: "web-apps" },
				},
				expectations: [imageExpectation(testMediaAssetId("a-ico"))],
			}),
		).toEqual({ ok: true });
	});

	it("refuses a file no CommCare app plays, and a ready row with no format as one", async () => {
		seed(testMediaAssetId("a-wav"), {
			kind: "audio",
			mimeType: "audio/wav",
			mediaFormat: "unplayable",
		});
		seed(testMediaAssetId("a-unknown"), {
			kind: "audio",
			mimeType: "audio/wav",
			mediaFormat: undefined,
		});
		for (const id of [
			testMediaAssetId("a-wav"),
			testMediaAssetId("a-unknown"),
		]) {
			expect(
				await mediaAttachVerdict({
					projectId: "project-1",
					doc: emptyDoc(),
					expectations: [
						{ assetId: id, kind: "audio", slot: "the audio label" },
					],
				}),
			).toEqual({
				ok: false,
				error: `Tried to attach asset "${id}" as the audio label, but no CommCare app can play it (WAV). Exporting it again as MP3, or M4A with AAC audio, and uploading that fixes it.`,
			});
		}
	});

	it("rejects when the attach would push the byte aggregate past the export ceiling", async () => {
		// One ready row whose recorded size alone exceeds the 200 MB budget.
		seed(testMediaAssetId("a-huge"), { sizeBytes: 201 * 1024 * 1024 });
		const verdict = await mediaAttachVerdict({
			projectId: "project-1",
			doc: emptyDoc(),
			expectations: [imageExpectation(testMediaAssetId("a-huge"))],
		});
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.error).toContain("export limit");
		expect(verdict.error).toContain("MB");
	});

	it("rejects when the attach would push the COUNT aggregate past the export ceiling", async () => {
		const expectations: MediaAttachExpectation[] = [];
		for (let i = 0; i < 501; i++) {
			const id = testMediaAssetId(`a-${i}`);
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
		seed(testMediaAssetId("a-existing"), { sizeBytes: 150 * 1024 * 1024 });
		seed(testMediaAssetId("a-new"), { sizeBytes: 60 * 1024 * 1024 });
		const doc = emptyDoc();
		doc.logo = testMediaAssetId("a-existing");
		const verdict = await mediaAttachVerdict({
			projectId: "project-1",
			doc,
			// The new ref alone is under budget; existing + new is over.
			expectations: [
				{
					assetId: testMediaAssetId("a-new"),
					kind: "image",
					slot: 'the icon on module "M"',
				},
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

const BOTH = ["web-apps", "android"] as const;
const PNG_ROW: MediaExpectationRow = {
	project_id: "project-1",
	status: "ready",
	kind: "image",
	mimeType: "image/png",
	mediaFormat: "png",
};

describe("describeMediaExpectationFailures", () => {
	it("refuses a foreign row even when supplied directly and cannot distinguish it from missing", () => {
		const id = testMediaAssetId("foreign");
		const expectations = [imageExpectation(id)];
		const foreign = describeMediaExpectationFailures(
			expectations,
			new Map([
				[
					id,
					{
						project_id: "private-project",
						status: "ready",
						kind: "image",
						mimeType: "image/png",
						mediaFormat: "png",
					},
				],
			]),
			"project-1",
			BOTH,
		);
		expect(foreign).not.toBeNull();
		expect(foreign).toBe(
			describeMediaExpectationFailures(
				expectations,
				new Map(),
				"project-1",
				BOTH,
			),
		);
	});
	it("reports every failed expectation, one line each, and null when all hold", () => {
		const table = new Map<MediaAssetId, MediaExpectationRow>([
			[testMediaAssetId("ok"), PNG_ROW],
			[testMediaAssetId("pending"), { ...PNG_ROW, status: "pending" }],
			[
				testMediaAssetId("wrong-kind"),
				{
					...PNG_ROW,
					kind: "video",
					mimeType: "video/mp4",
					mediaFormat: "mp4-h264-main",
				},
			],
		]);
		const failures = describeMediaExpectationFailures(
			[
				{ assetId: testMediaAssetId("ok"), kind: "image", slot: "slot A" },
				{ assetId: testMediaAssetId("pending"), kind: "image", slot: "slot B" },
				{
					assetId: testMediaAssetId("wrong-kind"),
					kind: "image",
					slot: "slot C",
				},
				{ assetId: testMediaAssetId("absent"), kind: "image", slot: "slot D" },
			],
			table,
			"project-1",
			BOTH,
		);
		expect(failures).not.toBeNull();
		const lines = (failures ?? "").split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("slot B");
		expect(lines[1]).toContain("slot C");
		expect(lines[2]).toContain("slot D");

		expect(
			describeMediaExpectationFailures(
				[{ assetId: testMediaAssetId("ok"), kind: "image", slot: "slot A" }],
				table,
				"project-1",
				BOTH,
			),
		).toBeNull();
	});
});
