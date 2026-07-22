/**
 * `listApps` behavioral regression tests, over a real Postgres (the per-test DB
 * harness).
 *
 * The contract these pin: soft-deleted rows are filtered in the QUERY
 * (`deleted_at IS NULL`) BEFORE the `LIMIT`, not stripped in JS after — so a
 * deleted-heavy scope still fills a full page of live rows and the "maybe more"
 * cursor stays accurate. A stale `generating` build projects to `status: "error"`
 * (and fires its reaper); a stale `complete` app is left untouched. The cursor's
 * sort discriminant must match the call's sort. These contracts are pinned on
 * the RESULT (the returned rows + cursor), not on query-builder internals.
 */

import { describe, expect, it, vi } from "vitest";
import { MAX_GENERATION_MINUTES } from "../constants";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("list_apps_");
const PROJECT = "proj-list";

/** A live app whose `updated_at` orders it by `rank` (higher rank = newer). */
async function seedLive(
	id: string,
	rank: number,
	over: Parameters<typeof h.seedApp>[0] = {},
): Promise<void> {
	await h.seedApp({
		id,
		project_id: PROJECT,
		app_name: `App ${id}`,
		status: "complete",
		updated_at: new Date(2026, 3, rank),
		...over,
	});
}

const staleClock = () =>
	new Date(Date.now() - (MAX_GENERATION_MINUTES + 5) * 60_000);

describe("listApps", () => {
	it("fills a full page of LIVE rows even when deleted rows share the scope (server-side filter, not a JS strip)", async () => {
		await seedLive("a", 5);
		await seedLive("b", 4);
		await h.seedApp({
			id: "d1",
			project_id: PROJECT,
			status: "complete",
			deleted_at: new Date(),
			recoverable_until: new Date(Date.now() + 1e9),
		});
		await h.seedApp({
			id: "d2",
			project_id: PROJECT,
			status: "complete",
			deleted_at: new Date(),
			recoverable_until: new Date(Date.now() + 1e9),
		});

		const { listApps } = await import("../apps");
		const page = await listApps(PROJECT, { limit: 2, sort: "updated_desc" });
		// Two LIVE rows fill the page; the deleted rows never entered the budget.
		expect(page.apps.map((x) => x.id)).toEqual(["a", "b"]);
		// A full page of live rows ⇒ an accurate "maybe more" cursor.
		expect(page.nextCursor).toBeDefined();
	});

	it("returns only live rows, newest first (soft-delete excluded)", async () => {
		await seedLive("a", 5);
		await seedLive("b", 4);
		await seedLive("c", 3);
		await h.seedApp({
			id: "gone",
			project_id: PROJECT,
			deleted_at: new Date(),
			recoverable_until: new Date(Date.now() + 1e9),
		});

		const { listApps } = await import("../apps");
		const { apps } = await listApps(PROJECT, {
			limit: 50,
			sort: "updated_desc",
		});
		expect(apps.map((x) => x.id)).toEqual(["a", "b", "c"]);
	});

	it("reaps a stale build regardless of awaiting_input, but spares a FRESH paused build", async () => {
		// The reaper keys on the LAPSED CLOCK, not `awaiting_input`: an abandoned
		// paused build (stale clock) and a hard-killed build both project 'error';
		// a recently-paused build (fresh clock) is alive and stays 'generating'.
		await h.seedApp({
			id: "freshPaused",
			project_id: PROJECT,
			status: "generating",
			run_id: "fresh-paused-run",
			awaiting_input: true,
			updated_at: new Date(),
		});
		await h.seedApp({
			id: "abandonedPaused",
			project_id: PROJECT,
			status: "generating",
			run_id: "abandoned-paused-run",
			awaiting_input: true,
			updated_at: staleClock(),
		});
		await h.seedApp({
			id: "killed",
			project_id: PROJECT,
			status: "generating",
			run_id: "killed-run",
			awaiting_input: false,
			updated_at: staleClock(),
		});

		const { listApps } = await import("../apps");
		const { apps } = await listApps(PROJECT, {
			limit: 50,
			sort: "updated_desc",
		});
		const statusById = Object.fromEntries(apps.map((a) => [a.id, a.status]));
		expect(statusById.freshPaused).toBe("generating");
		expect(statusById.abandonedPaused).toBe("error");
		expect(statusById.killed).toBe("error");

		// The projection SYNTHESIZES "error" immediately, but the actual row flip is
		// done by `projectAppSummary`'s fire-and-forget `reapStaleGenerating`. Drain
		// those reaps (wait for their committed effect) before the test ends, so no
		// in-flight transaction outlives teardown — the async-leak gate's contract.
		await vi.waitFor(async () => {
			expect((await h.readAppRow("abandonedPaused"))?.status).toBe("error");
			expect((await h.readAppRow("killed"))?.status).toBe("error");
		});
	});

	it("never reaps or fails a stale complete app — only a live build runs on the liveness timer", async () => {
		await h.seedApp({
			id: "at-rest",
			project_id: PROJECT,
			app_name: "At rest",
			status: "complete",
			updated_at: new Date("2020-01-01T00:00:00Z"),
		});

		const { listApps } = await import("../apps");
		const { apps } = await listApps(PROJECT, {
			limit: 50,
			sort: "updated_desc",
		});
		expect(apps[0]?.status).toBe("complete");
		expect(apps[0]?.error_type).toBeNull();
	});

	it("emits nextCursor when the page returns exactly `limit` rows", async () => {
		await seedLive("a", 2);
		await seedLive("b", 1);

		const { listApps } = await import("../apps");
		const result = await listApps(PROJECT, { limit: 2, sort: "updated_desc" });
		expect(result.apps).toHaveLength(2);
		expect(result.nextCursor).toBeDefined();
	});

	it("omits nextCursor when the page returns fewer than `limit` rows", async () => {
		await seedLive("a", 1);

		const { listApps } = await import("../apps");
		const result = await listApps(PROJECT, { limit: 10, sort: "updated_desc" });
		expect(result.apps).toHaveLength(1);
		expect(result.nextCursor).toBeUndefined();
	});

	it("binds the status filter — only rows of the requested status are returned", async () => {
		await seedLive("done", 3, { status: "complete" });
		await h.seedApp({
			id: "building",
			project_id: PROJECT,
			status: "generating",
			updated_at: new Date(),
		});
		await h.seedApp({
			id: "broken",
			project_id: PROJECT,
			status: "error",
			updated_at: new Date(2026, 3, 2),
		});

		const { listApps } = await import("../apps");
		const { apps } = await listApps(PROJECT, {
			limit: 50,
			sort: "updated_desc",
			status: "complete",
		});
		expect(apps.map((x) => x.id)).toEqual(["done"]);
	});

	it("paginates across pages via the returned cursor without repeating rows", async () => {
		await seedLive("a", 5);
		await seedLive("b", 4);
		await seedLive("c", 3);

		const { listApps } = await import("../apps");
		const page1 = await listApps(PROJECT, { limit: 2, sort: "updated_desc" });
		expect(page1.apps.map((x) => x.id)).toEqual(["a", "b"]);
		expect(page1.nextCursor).toBeDefined();

		const page2 = await listApps(PROJECT, {
			limit: 2,
			sort: "updated_desc",
			cursor: page1.nextCursor,
		});
		expect(page2.apps.map((x) => x.id)).toEqual(["c"]);
		expect(page2.nextCursor).toBeUndefined();
	});

	it("rejects a cursor minted under a different sort", async () => {
		await seedLive("a", 1);

		const { listApps } = await import("../apps");
		const seed = await listApps(PROJECT, { limit: 1, sort: "updated_desc" });
		expect(seed.nextCursor).toBeDefined();

		await expect(
			listApps(PROJECT, {
				limit: 1,
				sort: "name_asc",
				cursor: seed.nextCursor,
			}),
		).rejects.toThrow(/Cursor was minted/);
	});
});

describe("listAppsAcrossProjects", () => {
	it("scopes the scan to the membership set — the cross-Project MCP enumeration", async () => {
		await h.seedApp({
			id: "a1",
			project_id: "proj-a",
			updated_at: new Date(2026, 3, 3),
		});
		await h.seedApp({
			id: "b1",
			project_id: "proj-b",
			updated_at: new Date(2026, 3, 2),
		});
		await h.seedApp({
			id: "c1",
			project_id: "proj-c",
			updated_at: new Date(2026, 3, 1),
		});
		// A soft-deleted row in an in-scope Project is still excluded.
		await h.seedApp({
			id: "a-gone",
			project_id: "proj-a",
			deleted_at: new Date(),
			recoverable_until: new Date(Date.now() + 1e9),
		});

		const { listAppsAcrossProjects } = await import("../apps");
		const { apps } = await listAppsAcrossProjects(["proj-a", "proj-b"], {
			limit: 50,
			sort: "updated_desc",
		});
		expect(apps.map((x) => x.id)).toEqual(["a1", "b1"]);
	});

	it("returns an empty page WITHOUT querying when the caller belongs to no Projects", async () => {
		const { listAppsAcrossProjects } = await import("../apps");
		const result = await listAppsAcrossProjects([], {
			limit: 50,
			sort: "updated_desc",
		});
		expect(result).toEqual({ apps: [] });
	});
});
