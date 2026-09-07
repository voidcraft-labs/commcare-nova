/** Deletion and restoration are one persisted lifecycle: exactly two marker
 * columns change, reads stop while deleted, and the original app survives. */
import { expect, it } from "vitest";
import { loadAppProjectId, restoreApp, softDeleteApp } from "../apps";
import { CommitReauthError } from "../commitGuard";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("app_deletion_", { authSchema: "migrated" });
it.each(["complete", "error"] as const)(
	"deletes and restores a %s app without changing its other persisted state",
	async (status) => {
		const app = await h.seedApp({
			id: "app",
			owner: "creator",
			project_id: "project",
			status,
			error_type: status === "error" ? "internal" : null,
			run_id: "historic-run",
			updated_at: new Date("2026-04-01T00:00:00Z"),
		});
		await h.seedProjectMember("co-admin", "project", "admin");
		const before = await h.readAppRow(app);
		const entities = await h
			.db()
			.selectFrom("blueprint_entities")
			.selectAll()
			.where("app_id", "=", app)
			.orderBy("uuid")
			.execute();
		expect(entities.length).toBeGreaterThan(0);
		const start = Date.now();
		const deadline = await softDeleteApp(app, "co-admin");
		const end = Date.now();
		const deleted = await h.readAppRow(app);
		expect(deleted).toEqual({
			...before,
			deleted_at: expect.any(Date),
			recoverable_until: expect.any(Date),
		});
		if (
			!(deleted?.deleted_at instanceof Date) ||
			!(deleted.recoverable_until instanceof Date)
		)
			throw new Error("Missing deletion markers");
		expect(deleted.deleted_at.getTime()).toBeGreaterThanOrEqual(start);
		expect(deleted.deleted_at.getTime()).toBeLessThanOrEqual(end);
		expect(
			deleted.recoverable_until.getTime() - deleted.deleted_at.getTime(),
		).toBe(2_592_000_000);
		expect(deadline).toBe(deleted.recoverable_until.toISOString());
		expect(await loadAppProjectId(app)).toEqual({ kind: "not-found" });
		await restoreApp(app, "co-admin");
		expect(await h.readAppRow(app)).toEqual(before);
		expect(await loadAppProjectId(app)).toEqual({
			kind: "found",
			projectId: "project",
		});
		expect(
			await h
				.db()
				.selectFrom("blueprint_entities")
				.selectAll()
				.where("app_id", "=", app)
				.orderBy("uuid")
				.execute(),
		).toEqual(entities);
	},
);
it("refuses deletion and restoration by an underprivileged member without changing either state", async () => {
	const app = await h.seedApp({ owner: "creator", project_id: "project" });
	await h.seedProjectMember("member", "project", "editor");
	const active = await h.readAppRow(app);
	await expect(softDeleteApp(app, "member")).rejects.toBeInstanceOf(
		CommitReauthError,
	);
	expect(await h.readAppRow(app)).toEqual(active);
	await softDeleteApp(app, "creator");
	const deleted = await h.readAppRow(app);
	await expect(restoreApp(app, "member")).rejects.toBeInstanceOf(
		CommitReauthError,
	);
	expect(await h.readAppRow(app)).toEqual(deleted);
});
it("refuses nonexistent targets without creating a ghost row", async () => {
	for (const write of [softDeleteApp, restoreApp]) {
		await expect(write("missing", "member")).rejects.toBeInstanceOf(
			CommitReauthError,
		);
	}
	expect(await h.db().selectFrom("apps").selectAll().execute()).toEqual([]);
});
