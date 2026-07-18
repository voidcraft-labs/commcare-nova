/**
 * Authoritative media-library search against the real per-test Postgres.
 *
 * Search must run before cursor pagination. Otherwise a match older than the
 * first 50 rows is invisible until a user manually loads that page, while the
 * picker can incorrectly claim the whole library has no match.
 */

import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("media_search_");

describe("listReadyAssetsForProject search", () => {
	it("finds an older match that is absent from the first unfiltered page", async () => {
		const newestAt = Date.parse("2026-07-17T12:00:00.000Z");
		const rows = Array.from({ length: 51 }, (_, index) => {
			const id = `asset-${index.toString().padStart(2, "0")}`;
			const name =
				index === 50 ? "Community NEEDLE plan.pdf" : `file-${index}.pdf`;
			return {
				id,
				project_id: "project-1",
				owner: "user-1",
				content_hash: index.toString(16).padStart(64, "0"),
				mime_type: "application/pdf",
				extension: ".pdf",
				size_bytes: 1000 + index,
				dimensions: null,
				duration_ms: null,
				kind: "pdf",
				gcs_object_key: `projects/project-1/${id}.pdf`,
				original_filename: name,
				display_name: name,
				status: "ready",
				extract: null,
				created_at: new Date(newestAt - index * 1000),
			};
		});
		await h.db().insertInto("media_assets").values(rows).execute();

		const { listReadyAssetsForProject } = await import("../mediaAssets");
		const firstPage = await listReadyAssetsForProject("project-1");
		expect(firstPage.assets).toHaveLength(50);
		expect(firstPage.assets.some((asset) => asset.id === "asset-50")).toBe(
			false,
		);
		expect(firstPage.nextCursor).not.toBeNull();

		const searched = await listReadyAssetsForProject("project-1", {
			query: " needle ",
		});
		expect(searched.assets.map((asset) => asset.id)).toEqual(["asset-50"]);
		expect(searched.nextCursor).toBeNull();
	});
});
