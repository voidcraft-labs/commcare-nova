/**
 * `listDeletedApps` behavioral regression tests, over a real Postgres.
 *
 * The contract these pin: the trash query surfaces BOTH soft-delete timestamps —
 * `deleted_at` AND `recoverable_until` — as parseable ISO strings on each
 * summary, so the trash card's "Deleted X ago" line has a real date to format
 * (the "Deleted Invalid Date" regression). A row past its recovery window is
 * dropped before it reaches the UI — the trash is a recovery surface, not an
 * archive. (The former Firestore `.select()`-projection assertion is a builder
 * internal with no Postgres analogue; the same contract is pinned on the RESULT.)
 */

import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("list_deleted_");
const PROJECT = "proj-trash";

const DELETED_AT = new Date("2026-07-01T12:00:00.000Z");
const RECOVERABLE_FUTURE = new Date("2099-01-01T00:00:00Z");

/** Seed a soft-deleted app in the test Project. */
async function seedDeleted(
	id: string,
	over: { deleted_at?: Date; recoverable_until?: Date } = {},
): Promise<void> {
	await h.seedApp({
		id,
		project_id: PROJECT,
		app_name: `App ${id}`,
		status: "complete",
		module_count: 2,
		form_count: 3,
		deleted_at: over.deleted_at ?? DELETED_AT,
		recoverable_until: over.recoverable_until ?? RECOVERABLE_FUTURE,
	});
}

describe("listDeletedApps", () => {
	it("surfaces both soft-delete timestamps — deleted_at AND recoverable_until", async () => {
		await seedDeleted("a");

		const { listDeletedApps } = await import("../apps");
		const { apps } = await listDeletedApps(PROJECT, { limit: 50 });

		expect(apps).toHaveLength(1);
		expect(apps[0]?.deleted_at).toBe(DELETED_AT.toISOString());
		expect(apps[0]?.recoverable_until).toBe(RECOVERABLE_FUTURE.toISOString());
	});

	it("returns deleted_at as a parseable ISO string — the 'Deleted Invalid Date' regression", async () => {
		await seedDeleted("a");

		const { listDeletedApps } = await import("../apps");
		const { apps } = await listDeletedApps(PROJECT, { limit: 50 });

		expect(apps).toHaveLength(1);
		expect(Number.isNaN(new Date(apps[0]?.deleted_at ?? "").getTime())).toBe(
			false,
		);
	});

	it("filters rows whose recovery window has already elapsed", async () => {
		await seedDeleted("past", {
			recoverable_until: new Date("2000-01-01T00:00:00Z"),
		});
		await seedDeleted("live");

		const { listDeletedApps } = await import("../apps");
		const { apps } = await listDeletedApps(PROJECT, { limit: 50 });

		expect(apps.map((a) => a.id)).toEqual(["live"]);
	});

	it("orders most-recently-deleted first", async () => {
		await seedDeleted("older", {
			deleted_at: new Date("2026-06-01T00:00:00Z"),
		});
		await seedDeleted("newer", {
			deleted_at: new Date("2026-06-20T00:00:00Z"),
		});

		const { listDeletedApps } = await import("../apps");
		const { apps } = await listDeletedApps(PROJECT, { limit: 50 });

		expect(apps.map((a) => a.id)).toEqual(["newer", "older"]);
	});
});
