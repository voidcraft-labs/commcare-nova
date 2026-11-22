import { sql } from "kysely";
import { Client } from "pg";
import { beforeEach, expect, it } from "vitest";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import { testUuid } from "@/__tests__/helpers/uuid";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { waitForBlockedLocks } from "@/lib/db/__tests__/heldAppRow";
import { AppAccessError } from "@/lib/db/appAccess";
import {
	resolvePreviewSearchFacts,
	unconfirmedSearchValues,
} from "@/lib/preview/searchSettings";
import {
	readAuthorizedPreviewSearchCatalog,
	recoverPreviewSearchSettings,
	setPreviewSearchSettings,
} from "../previewSearchSettings";
import { endDeployment } from "../store";
import { birthAdoptedApp } from "./adoptedBirth";

const h = setupAppStateTestDb("preview_search_settings_", {
	authSchema: "migrated",
	poolMax: 4,
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
	propertyMatchers: { fuzzyProperties: [], ignoredText: [] },
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
		setPreviewSearchSettings(app, "viewer", eu, "1", {
			propertyMatchers: null,
		}),
	).rejects.toBeInstanceOf(AppAccessError);
	await expect(
		setPreviewSearchSettings(foreign, "author", eu, "0", confirmed),
	).rejects.toBeInstanceOf(AppAccessError);
	expect(
		await setPreviewSearchSettings(peer, "author", eu, "0", {
			propertyMatchers: null,
		}),
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

it.each(["save-first", "stop-first"] as const)(
	"serializes the first browser settings insert and a deployment ending, %s",
	async (order) => {
		const projectId = app.projectId;
		await h.seedProjectMember("publisher", projectId, "admin");
		const first = await birthAdoptedApp(h, {
			appId: testUuid("settings-source"),
			projectId,
			actorUserId: "publisher",
			target: eu,
			remoteAppId: "d".repeat(32),
		});
		const sibling = await birthAdoptedApp(h, {
			appId: testUuid("settings-sibling"),
			projectId,
			actorUserId: "publisher",
			target: eu,
			remoteAppId: "e".repeat(32),
		});
		const readPeer = async () =>
			resolvePreviewSearchFacts(
				await readAuthorizedPreviewSearchCatalog(
					sibling.scope.appId,
					projectId,
					"viewer",
				),
				eu,
			);
		const stop = () => endDeployment(first.scope, eu, "d".repeat(32));
		const save = () =>
			setPreviewSearchSettings(first.scope, "author", eu, "0", confirmed);
		let pending: Promise<PromiseSettledResult<void>[]> | undefined;
		let joined: PromiseSettledResult<void>[] | undefined;
		const outcomes: string[] = [];
		const operations = {
			save: async () => {
				outcomes.push((await save()).kind);
			},
			stop: async () => {
				await stop();
				outcomes.push("ended");
			},
		};
		const firstOp = order === "save-first" ? operations.save : operations.stop;
		const secondOp = order === "save-first" ? operations.stop : operations.save;
		const observer = new Client({ connectionString: h.uri() });
		await observer.connect();
		try {
			await whileBlocked(
				h,
				(pg) =>
					pg.query(
						order === "save-first"
							? "LOCK TABLE preview_search_settings IN SHARE MODE"
							: "LOCK TABLE app_deployments IN SHARE MODE",
					),
				firstOp,
				async () => {
					pending = Promise.allSettled([secondOp()]);
					// The second operation cannot commit in the interval between
					// eligibility and the first operation's blocked database write.
					await waitForBlockedLocks(observer, 2);
					expect(await readPeer()).toMatchObject(unconfirmedSearchValues);
				},
			);
		} finally {
			joined = await pending;
			await observer.end();
		}
		if (joined?.[0]?.status === "rejected") throw joined[0].reason;
		expect(outcomes.sort()).toEqual([
			"ended",
			order === "save-first" ? "saved" : "target-unavailable",
		]);
		expect(await readPeer()).toMatchObject(
			order === "save-first" ? confirmed : unconfirmedSearchValues,
		);
		expect(
			(
				await readAuthorizedPreviewSearchCatalog(
					first.scope.appId,
					projectId,
					"viewer",
				)
			).profiles.map((p) => p.target),
		).toEqual([local]);
	},
);

it("preserves an older search profile when the team confirms, corrects and clears a Web Apps record map", async () => {
	for (const scope of [app, peer, foreign]) await deploy(scope, eu.server);
	await setPreviewSearchSettings(app, "author", eu, "0", confirmed);
	const stored = () =>
		sql<{
			settings: Record<string, unknown>;
		}>`SELECT settings FROM preview_search_settings WHERE project_id=${app.projectId} AND server=${eu.server} AND domain=${eu.domain}`.execute(
			h.db(),
		);
	const read = async () =>
		resolvePreviewSearchFacts(
			await readAuthorizedPreviewSearchCatalog(
				peer.appId,
				peer.projectId,
				"viewer",
			),
			eu,
		);
	expect((await stored()).rows[0].settings).not.toHaveProperty("caseListMap");
	expect((await read()).caseListMap).toBeNull();
	expect(
		await setPreviewSearchSettings(app, "author", eu, "1", {
			caseListMap: true,
		}),
	).toMatchObject({ kind: "saved", savedRevision: "2" });
	expect(await read()).toMatchObject({ ...confirmed, caseListMap: true });
	expect(
		await setPreviewSearchSettings(peer, "author", eu, "1", {
			caseListMap: false,
		}),
	).toMatchObject({ kind: "changed" });
	expect(
		await setPreviewSearchSettings(peer, "author", eu, "2", {
			caseListMap: false,
		}),
	).toMatchObject({ kind: "saved", savedRevision: "3" });
	const disabled = await read();
	expect(disabled.caseListMap).toBe(false);
	expect(
		resolvePreviewSearchFacts(
			await readAuthorizedPreviewSearchCatalog(
				foreign.appId,
				foreign.projectId,
				"other",
			),
			eu,
		).caseListMap,
	).toBeNull();
	await expect(
		setPreviewSearchSettings(app, "viewer", eu, "3", { caseListMap: true }),
	).rejects.toBeInstanceOf(AppAccessError);
	expect(
		await setPreviewSearchSettings(app, "author", eu, "3", {
			caseListMap: null,
		}),
	).toMatchObject({ kind: "saved", savedRevision: "4" });
	expect((await read()).revision).not.toBe(disabled.revision);
	expect((await stored()).rows[0].settings).toEqual({
		...confirmed,
		caseListMap: null,
	});
});
