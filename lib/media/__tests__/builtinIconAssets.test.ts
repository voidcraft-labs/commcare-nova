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
import { iconCatalogEntry } from "@/lib/domain/builtinIcons";
import {
	builtinAssetRows,
	partitionAssetRefs,
	resolveBuiltinManifestEntries,
} from "../builtinIconAssets";

describe("partitionAssetRefs", () => {
	it("splits real ids from built-in slugs, deduping and dropping stale slugs", () => {
		const { realIds, builtinSlugs } = partitionAssetRefs([
			"nova-icon:household",
			"a1b2c3d4-uuid",
			"nova-icon:household", // duplicate → collapses
			"nova-icon:bogus", // stale → dropped (fails closed)
			"nova-icon:register",
		]);
		expect(realIds).toEqual(["a1b2c3d4-uuid"]);
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

	it("loads the shipped bytes when withBytes is true, and they hash to the catalog", async () => {
		const entries = await resolveBuiltinManifestEntries(["household"], true);
		const [, asset] = entries[0];
		expect(asset.bytes).toBeInstanceOf(Buffer);
		// The shipped PNG's actual hash must equal the catalog's recorded hash —
		// otherwise the content-hash wire path points at the wrong bytes.
		const actual = createHash("sha256")
			.update(asset.bytes as Buffer)
			.digest("hex");
		expect(actual).toBe(iconCatalogEntry("household")?.contentHash);
	});

	it("dedupes nothing here (the caller dedupes slugs) but resolves each given slug", async () => {
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
