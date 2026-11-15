/** Deletion and restoration are one persisted lifecycle: exactly two marker
 * columns change, reads stop while deleted, and the original app survives. */
import { expect, it } from "vitest";
import { loadAppProjectId, restoreApp, softDeleteApp } from "../apps";
import { CommitReauthError } from "../commitGuard";
import { claimHqAppInTransaction } from "../hqAppClaims";
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
		await expect(restoreApp(app, "co-admin")).resolves.toEqual({
			stoppedPublishing: [],
		});
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

async function seedPublishedApp(appId: string): Promise<string> {
	await h.seedApp({ id: appId, owner: "creator", project_id: "project" });
	const deployment = await h
		.db()
		.insertInto("app_deployments")
		.values({
			app_id: appId,
			project_id: "project",
			server: "production",
			domain: "acme",
			state: "uploaded",
			phases: JSON.stringify({}),
			created_by: "creator",
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return deployment.id;
}

async function mapApp(
	deploymentId: string,
	appId: string,
	remoteAppId: string,
): Promise<void> {
	await h
		.db()
		.insertInto("app_deployment_resources")
		.values({
			deployment_id: deploymentId,
			kind: "app",
			nova_resource_id: appId,
			remote_id: remoteAppId,
			ownership: "nova-created",
			pushed_revision: 1,
			pushed_at: new Date("2026-11-02T00:00:00.000Z"),
		})
		.execute();
}

it("deletes a published app without writing a deployment row, and restores it as it was", async () => {
	const remoteAppId = "a".repeat(32);
	const deployment = await seedPublishedApp("published");
	await mapApp(deployment, "published", remoteAppId);
	const ledger = async () => ({
		deployments: await h
			.db()
			.selectFrom("app_deployments")
			.selectAll()
			.execute(),
		mappings: await h
			.db()
			.selectFrom("app_deployment_resources")
			.selectAll()
			.execute(),
	});
	const before = await ledger();

	await softDeleteApp("published", "creator");
	expect(await ledger()).toEqual(before);

	await expect(restoreApp("published", "creator")).resolves.toEqual({
		stoppedPublishing: [],
	});
	expect(await ledger()).toEqual(before);
});

it("answers the project spaces a restore stopped publishing to", async () => {
	const remoteAppId = "a".repeat(32);
	const deleted = await seedPublishedApp("given-up");
	await mapApp(deleted, "given-up", remoteAppId);
	await softDeleteApp("given-up", "creator");
	const taker = await seedPublishedApp("taker");
	await h.withTransaction(async (tx) => {
		await claimHqAppInTransaction(tx, {
			server: "production",
			domain: "acme",
			remoteAppId,
		});
		await tx
			.insertInto("app_deployment_resources")
			.values({
				deployment_id: taker,
				kind: "app",
				nova_resource_id: "taker",
				remote_id: remoteAppId,
				ownership: "adopted",
				adopted_at: new Date("2026-11-10T00:00:00.000Z"),
				adopted_by: "creator",
				pushed_revision: 1,
			})
			.execute();
	});

	await expect(restoreApp("given-up", "creator")).resolves.toEqual({
		stoppedPublishing: [{ server: "production", domain: "acme" }],
	});
	expect(
		await h
			.db()
			.selectFrom("app_deployments")
			.select(["state", "endings"])
			.where("id", "=", deleted)
			.executeTakeFirstOrThrow(),
	).toEqual({ state: "ended", endings: 1 });
});
