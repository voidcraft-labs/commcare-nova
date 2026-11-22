import { sql } from "kysely";
import { beforeEach, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { AppAccessError } from "@/lib/db/appAccess";
import {
	localSearchDefaults,
	resolvePreviewSearchFacts,
	unconfirmedSearchValues,
} from "@/lib/preview/searchSettings";
import {
	readAuthorizedPreviewSearchCatalog,
	recoverPreviewSearchSettings,
	setPreviewSearchSettings,
} from "../previewSearchSettings";

const h = setupAppStateTestDb("preview_search_settings_", {
	authSchema: "migrated",
});
const eu = { kind: "destination", server: "eu", domain: "clinic" } as const;
const india = { ...eu, server: "india" } as const;
const local = { kind: "local" } as const;
const app = { appId: "one", projectId: "project-a" };
const peer = { appId: "two", projectId: "project-a" };
const foreign = { appId: "other-app", projectId: "project-b" };
const confirmed = {
	maximum: 1500 as const,
	timeZone: "Asia/Kolkata",
	propertyMatchers: [],
};
async function deploy(scope: typeof app, server: string, domain = "clinic") {
	await sql`INSERT INTO app_deployments (app_id,project_id,server,domain,state,created_by)
		VALUES (${scope.appId},${scope.projectId},${server},${domain},'uploaded','publisher')`.execute(
		h.db(),
	);
}
beforeEach(async () => {
	for (const scope of [app, peer, foreign])
		await h.seedApp({
			id: scope.appId,
			owner: "seed",
			project_id: scope.projectId,
		});
	await h.seedProjectMember("author", app.projectId, "editor");
	await h.seedProjectMember("viewer", app.projectId, "viewer");
	await h.seedProjectMember("other", foreign.projectId, "owner");
});
it("shares a confirmed destination across its Project's apps, protects a foreign Project and pinpoints the changed revision", async () => {
	for (const scope of [app, peer, foreign]) await deploy(scope, eu.server);
	const read = (scope: typeof app, actor: string) =>
		readAuthorizedPreviewSearchCatalog(scope.appId, scope.projectId, actor);
	expect(resolvePreviewSearchFacts(await read(app, "viewer"))).toMatchObject(
		unconfirmedSearchValues,
	);
	expect(
		await setPreviewSearchSettings(app, "author", eu, "0", confirmed),
	).toMatchObject({ kind: "saved", savedRevision: "1" });
	const old = resolvePreviewSearchFacts(await read(peer, "viewer"), eu);
	expect(old).toMatchObject(confirmed);
	expect(
		resolvePreviewSearchFacts(await read(foreign, "other"), eu),
	).toMatchObject(unconfirmedSearchValues);
	await expect(read(foreign, "author")).rejects.toBeInstanceOf(AppAccessError);
	await expect(
		readAuthorizedPreviewSearchCatalog(peer.appId, foreign.projectId, "author"),
	).rejects.toBeInstanceOf(AppAccessError);
	await expect(
		setPreviewSearchSettings(app, "viewer", eu, "1", unconfirmedSearchValues),
	).rejects.toBeInstanceOf(AppAccessError);
	await expect(
		setPreviewSearchSettings(foreign, "author", eu, "0", confirmed),
	).rejects.toBeInstanceOf(AppAccessError);
	expect(
		await setPreviewSearchSettings(
			peer,
			"author",
			eu,
			"0",
			unconfirmedSearchValues,
		),
	).toMatchObject({ kind: "changed" });
	await setPreviewSearchSettings(peer, "author", eu, "1", {
		...confirmed,
		timeZone: null,
	});
	const fresh = resolvePreviewSearchFacts(await read(app, "viewer"), eu);
	expect(fresh).toMatchObject({ ...confirmed, timeZone: null });
	expect(fresh.revision).not.toBe(old.revision);
	await h.seedProjectMember("author", app.projectId, "viewer");
	await expect(
		setPreviewSearchSettings(peer, "author", eu, "2", confirmed),
	).rejects.toBeInstanceOf(AppAccessError);
});
it("keeps a local profile separate after first publish, and separates destinations with the same domain", async () => {
	expect(
		await setPreviewSearchSettings(app, "author", local, "0", {
			...localSearchDefaults,
			timeZone: "Europe/Paris",
		}),
	).toMatchObject({ kind: "saved" });
	await deploy(app, eu.server);
	expect(
		await setPreviewSearchSettings(app, "author", local, "1", confirmed),
	).toMatchObject({ kind: "target-unavailable" });
	expect(
		await setPreviewSearchSettings(app, "author", india, "0", confirmed),
	).toMatchObject({ kind: "target-unavailable" });
	await deploy(app, india.server);
	await setPreviewSearchSettings(app, "author", india, "0", confirmed);
	const catalog = await readAuthorizedPreviewSearchCatalog(
		app.appId,
		app.projectId,
		"viewer",
	);
	expect(resolvePreviewSearchFacts(catalog, india)).toMatchObject(confirmed);
	expect(resolvePreviewSearchFacts(catalog, eu)).toMatchObject(
		unconfirmedSearchValues,
	);
	expect(resolvePreviewSearchFacts(catalog)).toMatchObject({
		...unconfirmedSearchValues,
		projectSpace: "clinic",
	});
});

it("returns the same committed tool receipt after a later edit and reauthorizes the actor on recovery", async () => {
	await deploy(app, eu.server);
	const tool = {
		...app,
		actorUserId: "author",
		role: "editor",
		requestId: "confirmed-search",
	};
	expect(
		await setPreviewSearchSettings(app, "author", eu, "0", confirmed, tool),
	).toMatchObject({ kind: "saved", savedRevision: "1" });
	expect(
		await setPreviewSearchSettings(app, "author", eu, "1", confirmed),
	).toMatchObject({ kind: "saved", savedRevision: "1" });
	expect(
		await setPreviewSearchSettings(app, "author", eu, "1", {
			...confirmed,
			timeZone: "UTC",
		}),
	).toMatchObject({ kind: "saved", savedRevision: "2" });
	expect(await recoverPreviewSearchSettings(tool)).toBe("1");
	expect(
		await setPreviewSearchSettings(app, "author", eu, "0", confirmed, tool),
	).toMatchObject({ kind: "saved", savedRevision: "1" });
	await expect(
		setPreviewSearchSettings(
			app,
			"author",
			eu,
			"0",
			{ ...confirmed, timeZone: "UTC" },
			tool,
		),
	).rejects.toThrow("different search settings");
	await h.seedProjectMember("author", app.projectId, "viewer");
	await expect(recoverPreviewSearchSettings(tool)).rejects.toThrow();
});
