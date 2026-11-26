/**
 * `resolveMediaManifest`'s wire paths: the path the export's target holds
 * for an uploaded file, else the file's content-hash path, and always the
 * content-hash path for a built-in icon. Only the Project-scoped Postgres
 * read is replaced; the manifest is resolved path-only, so no storage read
 * runs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { wirePathFor } from "@/lib/commcare/multimedia/assetWirePath";
import { makeAssetRecord } from "@/lib/commcare/validator/rules/media/__tests__/fixtures";
import { loadAssetsByIds } from "@/lib/db/mediaAssets";
import { builtinIconRef, iconCatalogEntry } from "@/lib/domain/builtinIcons";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import { proseText } from "@/lib/domain/prose";
import { downloadAssetBytes } from "@/lib/storage/media";
import { resolveMediaManifest } from "../manifest";

vi.mock("@/lib/db/mediaAssets", () => ({ loadAssetsByIds: vi.fn() }));
vi.mock("@/lib/storage/media", () => ({ downloadAssetBytes: vi.fn() }));

const PROJECT = "project-1";
const LABEL = testMediaAssetId("manifest-label");
const HINT = testMediaAssetId("manifest-help");
const LABEL_HASH = "c".repeat(64);
const HINT_HASH = "d".repeat(64);

/** A survey whose one question carries two uploaded images and whose menu carries a built-in icon. */
function doc() {
	const built = buildDoc({
		appName: "Media",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "text",
								id: "note",
								label: proseText("Note"),
								help: proseText("Help"),
								label_media: { image: LABEL },
								help_media: { image: HINT },
							}),
						],
					},
				],
			},
		],
	});
	built.modules[built.moduleOrder[0]].icon = builtinIconRef("household");
	return built;
}

beforeEach(() => {
	vi.mocked(loadAssetsByIds).mockReset();
	vi.mocked(downloadAssetBytes).mockReset();
	vi.mocked(loadAssetsByIds).mockResolvedValue([
		makeAssetRecord("manifest-label", { id: LABEL, contentHash: LABEL_HASH }),
		makeAssetRecord("manifest-help", { id: HINT, contentHash: HINT_HASH }),
	]);
});

function wirePaths(
	manifest: Awaited<ReturnType<typeof resolveMediaManifest>>,
): Record<string, string> {
	return Object.fromEntries(
		[...manifest].map(([id, asset]) => [id, asset.wirePath]),
	);
}

describe("resolveMediaManifest wire paths", () => {
	const household = iconCatalogEntry("household");
	if (household === undefined) throw new Error("The catalog lost household");
	const iconPath = wirePathFor(household.contentHash, ".png");

	it("resolves translated files through the same Project read and counts a file shared by two translations once", async () => {
		const localized = doc();
		const menu = localized.modules[localized.moduleOrder[0]];
		const unknown = testMediaAssetId("other-project-image");
		menu.mediaByLanguage = { fra: { icon: unknown }, spa: { icon: unknown } };
		localized.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "fra", "spa"],
			translations: { fra: {}, spa: {} },
			wireCodes: { eng: "en", fra: "fr", spa: "es" },
		};
		const manifest = await resolveMediaManifest(localized, PROJECT, {
			withBytes: false,
		});
		const [[requested, project]] = vi.mocked(loadAssetsByIds).mock.calls;
		expect(project).toBe(PROJECT);
		expect(requested.filter((id) => id === unknown)).toEqual([unknown]);
		expect(manifest.has(unknown)).toBe(false);
		expect(downloadAssetBytes).not.toHaveBeenCalled();
	});

	it("gives a file its content-hash path where the target holds none", async () => {
		const manifest = await resolveMediaManifest(doc(), PROJECT, {
			withBytes: false,
		});
		expect(wirePaths(manifest)).toEqual({
			[LABEL]: `commcare/${LABEL_HASH}.png`,
			[HINT]: `commcare/${HINT_HASH}.png`,
			[builtinIconRef("household")]: iconPath,
		});
		expect(loadAssetsByIds).toHaveBeenCalledWith(
			expect.arrayContaining([LABEL, HINT]),
			PROJECT,
		);
		expect(downloadAssetBytes).not.toHaveBeenCalled();
	});

	it("gives a file the path its target holds, and the others their content-hash paths", async () => {
		const heldPaths = new Map<MediaAssetId, string>([[LABEL, "media/cow.png"]]);
		const manifest = await resolveMediaManifest(doc(), PROJECT, {
			withBytes: false,
			heldPaths,
		});
		expect(wirePaths(manifest)).toEqual({
			[LABEL]: "media/cow.png",
			[HINT]: `commcare/${HINT_HASH}.png`,
			[builtinIconRef("household")]: iconPath,
		});
		// The held path changes only where the file is; what it is stays.
		expect(manifest.get(LABEL)).toMatchObject({
			contentHash: LABEL_HASH,
			extension: ".png",
		});
	});

	it("never holds a built-in icon, which has no asset row", async () => {
		const heldPaths = new Map<MediaAssetId, string>([
			[LABEL, "commcare/image/cow.png"],
			[HINT, "commcare/image/help.png"],
		]);
		const manifest = await resolveMediaManifest(doc(), PROJECT, {
			withBytes: false,
			heldPaths,
		});
		expect(manifest.get(builtinIconRef("household"))?.wirePath).toBe(iconPath);
		expect(loadAssetsByIds).toHaveBeenCalledWith(
			expect.not.arrayContaining([builtinIconRef("household")]),
			PROJECT,
		);
	});
});
