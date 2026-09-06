/**
 * Tests for the server-side built-in icon bridge — how a `nova-icon:<slug>` ref
 * flows through the export pipeline without a `media_assets` row or GCS object.
 *
 * `partitionAssetRefs` / `builtinAssetRows` are pure; `resolveBuiltinManifestEntries`
 * reads the REAL shipped PNGs from `public/nova-icons/` (committed by the build
 * script), so the byte path is exercised end-to-end — including the integrity
 * check that the shipped bytes hash to the catalog's recorded contentHash, which
 * is what makes the content-hash wire path + cross-app dedup sound.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import {
	builtinIconRef,
	ICON_CATALOG,
	iconCatalogEntry,
} from "@/lib/domain/builtinIcons";
import {
	builtinAssetRows,
	partitionAssetRefs,
	resolveBuiltinManifestEntries,
} from "../builtinIconAssets";

describe("partitionAssetRefs", () => {
	it("splits uploaded ids from built-in refs and dedupes built-in slugs", () => {
		const uploaded = testMediaAssetId("uploaded");
		const { realIds, builtinSlugs } = partitionAssetRefs([
			builtinIconRef("household"),
			uploaded,
			builtinIconRef("household"), // duplicate → collapses
			builtinIconRef("register"),
		]);
		expect(realIds).toEqual([uploaded]);
		expect(builtinSlugs).toEqual(["household", "register"]);
	});

	it("returns empty arrays for no refs", () => {
		expect(partitionAssetRefs([])).toEqual({ realIds: [], builtinSlugs: [] });
	});
});

describe("builtinAssetRows", () => {
	it("synthesizes a ready, image, correctly-sized row per slug", () => {
		const [row] = builtinAssetRows(["household"]);
		const entry = iconCatalogEntry("household");
		expect(row.id).toBe("nova-icon:household");
		expect(row.status).toBe("ready");
		expect(row.kind).toBe("image");
		expect(row.mimeType).toBe("image/png");
		expect(row.extension).toBe(".png");
		expect(row.sizeBytes).toBe(entry?.sizeBytes);
		expect(row.contentHash).toBe(entry?.contentHash);
	});
});

describe("resolveBuiltinManifestEntries", () => {
	it("resolves a content-hash wire path without bytes when withBytes is false", async () => {
		const entries = await resolveBuiltinManifestEntries(["household"], false);
		expect(entries).toHaveLength(1);
		const [id, asset] = entries[0];
		const entry = iconCatalogEntry("household");
		expect(id).toBe("nova-icon:household");
		expect(asset.wirePath).toBe(`commcare/${entry?.contentHash}.png`);
		expect(asset.kind).toBe("image");
		expect(asset.mimeType).toBe("image/png");
		expect(asset.contentHash).toBe(entry?.contentHash);
		expect(asset.bytes).toBeUndefined();
	});

	it("loads every shipped icon with the catalog hash and byte count", async () => {
		// Read sequentially so this integrity check does not fan out filesystem work.
		for (const entry of ICON_CATALOG) {
			const [[id, asset]] = await resolveBuiltinManifestEntries(
				[entry.slug],
				true,
			);
			expect(id).toBe(builtinIconRef(entry.slug));
			if (asset.bytes === undefined)
				throw new Error(`Missing bytes for ${entry.slug}`);
			expect(
				createHash("sha256").update(asset.bytes).digest("hex"),
				entry.slug,
			).toBe(entry.contentHash);
			expect(asset.bytes.length, entry.slug).toBe(entry.sizeBytes);
		}
	});

	it("resolves every requested slug in request order", async () => {
		const entries = await resolveBuiltinManifestEntries(
			["household", "register"],
			false,
		);
		expect(entries.map(([id]) => id)).toEqual([
			"nova-icon:household",
			"nova-icon:register",
		]);
	});
});
