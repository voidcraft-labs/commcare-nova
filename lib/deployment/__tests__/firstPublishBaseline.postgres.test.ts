/**
 * The first-publish list a baseline keeps, in real Postgres: written by the
 * birth of an app brought in from CommCare HQ, kept by a refresh of the same
 * HQ app, ended by the push that replaces the baseline, and read back for a
 * viewer without CommCare HQ's source.
 *
 * Contract: `writeAppBaseline`'s two arms (`set` writes the list or clears
 * it, `keep` keeps it over the same HQ app and leaves none over another),
 * the CHECK that holds no list beside a `create` or an `unread` baseline,
 * `readFirstPublishStates` (a viewer's read that drops an id the registry no
 * longer holds and reads a value of any other shape as no list, logged), and
 * `readDeploymentsAction`, whose view shows the list while the live mapping
 * is the one it was kept for and none once the deployment is ended.
 *
 * Plausible failures: a list that outlives the baseline it describes, or is
 * lost before the first publish; a push that fails the CHECK; an older read
 * that rewrites the list; a viewer's Publishing card that throws over a
 * registry edit; a read that pulls the source to answer a viewer.
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Kysely, PostgresDialect, sql } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { getSession } from "@/lib/auth-utils";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { __setAppDbForTests, type AppDatabase } from "@/lib/db/pg";
import { log } from "@/lib/logger";
import type { StoredFirstPublish } from "@/lib/publish/firstPublishChangeIds";
import { readDeploymentsAction } from "../actions";
import { firstPublishOf } from "../resources";
import {
	readAppBaseline,
	readDeployment,
	readFirstPublishStates,
	recordRefreshedAppBaseline,
	recordRemoteResource,
} from "../store";
import type { AppBaselineWrite } from "../types";
import {
	appMappingToken,
	birthAdoptedApp,
	OWNERSHIP,
	READ_AT,
	SOURCE,
} from "./adoptedBirth";
import { readable } from "./readableRecord";
import { stopHere } from "./stopHere";

vi.mock("@/lib/auth-utils", () => ({ getSession: vi.fn() }));

const h = setupAppStateTestDb("first_publish_", {
	authSchema: "migrated",
	poolMax: 4,
});

const ACTOR = "bringer";
const VIEWER = "looker";
const STRANGER = "passer-by";
const PROJECT = "project-clinic";
const TARGET = { server: "production" as const, domain: "clinic" };
const HQ_APP = "c".repeat(32);
const OTHER_HQ_APP = "d".repeat(32);
const APP = testUuid("first-publish-app");
const BORN_LIST: StoredFirstPublish = {
	reviewed: 1,
	ids: ["forms-and-settings-rewritten"],
	webAppsOnInHq: true,
	of: "first-publish",
};

async function born() {
	await h.seedProjectMember(ACTOR, PROJECT, "owner");
	await h.seedProjectMember(VIEWER, PROJECT, "viewer");
	return birthAdoptedApp(h, {
		appId: APP,
		projectId: PROJECT,
		actorUserId: ACTOR,
		target: TARGET,
		remoteAppId: HQ_APP,
	});
}

const viewerScope = {
	appId: APP,
	projectId: PROJECT,
	role: "viewer" as const,
	actorUserId: VIEWER,
};

async function storedList(): Promise<unknown> {
	const row = await h
		.db()
		.selectFrom("app_deployment_baselines")
		.select(["first_publish_changes"])
		.executeTakeFirstOrThrow();
	return row.first_publish_changes;
}

/** A baseline that holds `SOURCE`, read at `observedAt` from `remoteAppId`. */
function readBaseline(
	origin: "push" | "read",
	remoteAppId: string,
	observedAt: string,
	firstPublish: AppBaselineWrite["firstPublish"],
): AppBaselineWrite {
	const text = JSON.stringify(SOURCE);
	return {
		origin,
		remoteAppId,
		sourceGzip: gzipSync(Buffer.from(text, "utf8")),
		sourceBytes: Buffer.byteLength(text, "utf8"),
		sourceDigest: createHash("sha256").update(text).digest("hex"),
		ownership: OWNERSHIP,
		observedAt,
		discard: null,
		novaRevision: 2,
		mediaFiles: { kind: "keep" },
		firstPublish,
	};
}

async function push(
	scope: Awaited<ReturnType<typeof born>>["scope"],
	baseline: AppBaselineWrite,
	ownership: "adopted" | "nova-created" = "adopted",
) {
	return recordRemoteResource(scope, TARGET, {
		expectedEndings: 0,
		kind: "app",
		novaResourceId: APP,
		remoteId: baseline.remoteAppId,
		ownership,
		...(ownership === "adopted" && { adoptedBy: ACTOR }),
		pushedRevision: 2,
		remoteRevision: 42,
		uploadedAt: baseline.observedAt,
		baseline,
	}).then(readable);
}

describe("the stored first-publish list", () => {
	it("is read back for a viewer from the birth's baseline, and a stranger finds no app", async () => {
		const birth = await born();
		const states = await readFirstPublishStates(viewerScope);
		expect([...states.values()]).toEqual([
			{ remoteAppId: HQ_APP, stored: BORN_LIST },
		]);
		expect(
			firstPublishOf(
				birth.deployment,
				states.get(birth.deployment.deployment.id),
				{
					connectType: null,
					appSettings: { runsOnlyOn: "android", showIncompleteForms: false },
				},
			),
		).toEqual({
			ids: ["forms-and-settings-rewritten", "web-apps-turned-off"],
			touchesWorkers: true,
			of: "first-publish",
		});

		vi.mocked(getSession).mockResolvedValue({
			user: { id: STRANGER },
		} as never);
		const refused = await readDeploymentsAction(APP);
		expect(refused).toMatchObject({ success: false, code: "not_found" });
	});

	it("ends with the push that replaces the baseline, in the one upsert, and the CHECK holds", async () => {
		const birth = await born();
		await push(
			birth.scope,
			readBaseline("push", HQ_APP, "2026-11-12T00:00:00.000Z", {
				kind: "set",
				list: null,
			}),
		);
		expect(await storedList()).toBeNull();
		expect((await readAppBaseline(birth.scope, TARGET))?.origin).toBe("push");
		expect((await readFirstPublishStates(viewerScope)).size).toBe(0);
	});

	it("is refused beside a create or an unread baseline", async () => {
		await born();
		for (const origin of ["create", "unread"] as const) {
			const refusal = await sql`
				UPDATE app_deployment_baselines
				SET origin = ${origin},
					source_gzip = NULL, source_bytes = NULL, source_digest = NULL,
					ownership = NULL
				WHERE first_publish_changes IS NOT NULL
			`
				.execute(h.db())
				.then(
					() => null,
					(error: { code?: string; constraint?: string }) => ({
						code: error.code,
						constraint: error.constraint,
					}),
				);
			expect(refusal).toEqual({
				code: "23514",
				constraint:
					"app_deployment_baselines_first_publish_changes_need_a_source",
			});
		}
	});

	it("stays through a refresh of the same HQ app, which keeps it", async () => {
		const birth = await born();
		const stored = await readAppBaseline(birth.scope, TARGET);
		if (stored === null || stored.origin === "unread")
			throw new Error("The birth holds a read baseline.");
		const text = JSON.stringify(SOURCE);
		const refreshed = await recordRefreshedAppBaseline(birth.scope, TARGET, {
			expectedEndings: 0,
			remoteAppId: HQ_APP,
			comparedDigest: stored.sourceDigest,
			comparedPushToken: appMappingToken(birth.deployment),
			read: {
				sourceGzip: gzipSync(Buffer.from(text, "utf8")),
				sourceBytes: Buffer.byteLength(text, "utf8"),
				sourceDigest: stored.sourceDigest,
				observedAt: "2026-11-12T00:00:00.000Z",
			},
		});
		expect(refreshed.outcome).toBe("current");
		expect(await storedList()).toEqual(BORN_LIST);
	});

	it("is left out by a keep over another HQ app", async () => {
		const birth = await born();
		await push(
			birth.scope,
			readBaseline("push", OTHER_HQ_APP, "2026-11-12T00:00:00.000Z", {
				kind: "keep",
			}),
		);
		expect(await storedList()).toBeNull();
	});

	it("holds a list of the next publish over a push baseline, which firstPublishOf answers for a mapping Nova created", async () => {
		const birth = await born();
		const next: StoredFirstPublish = {
			ids: ["case-settings-respelled"],
			webAppsOnInHq: false,
			of: "next-publish",
		};
		const deployment = await push(
			birth.scope,
			readBaseline("push", OTHER_HQ_APP, "2026-11-12T00:00:00.000Z", {
				kind: "set",
				list: next,
			}),
			"nova-created",
		);
		const states = await readFirstPublishStates(viewerScope);
		const state = states.get(deployment.deployment.id);
		expect(state).toEqual({ remoteAppId: OTHER_HQ_APP, stored: next });
		expect(
			firstPublishOf(deployment, state, {
				connectType: null,
				appSettings: {
					runsOnlyOn: undefined,
					showIncompleteForms: false,
				},
			}),
		).toEqual({
			ids: ["case-settings-respelled", "web-apps-turned-on"],
			touchesWorkers: true,
			of: "next-publish",
		});
	});

	it("is not changed by an older read the upsert turns away", async () => {
		const birth = await born();
		await push(
			birth.scope,
			readBaseline("read", HQ_APP, "2026-11-01T00:00:00.000Z", {
				kind: "set",
				list: { ids: [], webAppsOnInHq: false, of: "first-publish" },
			}),
		);
		expect(await storedList()).toEqual(BORN_LIST);
		expect((await readAppBaseline(birth.scope, TARGET))?.observedAt).toBe(
			READ_AT,
		);
	});

	it("drops an id the registry no longer holds and keeps the rest", async () => {
		await born();
		const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
		try {
			await h
				.db()
				.updateTable("app_deployment_baselines")
				.set({
					first_publish_changes: JSON.stringify({
						ids: ["forms-and-settings-rewritten", "no-longer-registered"],
						reviewed: 1,
						webAppsOnInHq: true,
						of: "first-publish",
					}),
				})
				.execute();
			const states = await readFirstPublishStates(viewerScope);
			expect([...states.values()].map((one) => one.stored)).toEqual([
				BORN_LIST,
			]);
			expect(warn).toHaveBeenCalledWith(
				"[deployment] first-publish change no longer registered",
				expect.objectContaining({ changeId: "no-longer-registered" }),
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("reads a value of another shape as no list, and logs it", async () => {
		const birth = await born();
		const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
		try {
			for (const value of [
				{ ids: "forms-and-settings-rewritten", webAppsOnInHq: true, of: "x" },
				{ ids: [], webAppsOnInHq: true },
				["forms-and-settings-rewritten"],
			]) {
				error.mockClear();
				await h
					.db()
					.updateTable("app_deployment_baselines")
					.set({ first_publish_changes: JSON.stringify(value) })
					.execute();
				expect((await readFirstPublishStates(viewerScope)).size).toBe(0);
				expect(error).toHaveBeenCalledTimes(1);
				expect(error.mock.calls[0]?.[0]).toContain(
					`The deployment ${birth.deployment.deployment.id} holds first-publish changes Nova can't read`,
				);
			}
		} finally {
			error.mockRestore();
		}
	});

	it("reads no source for a viewer", async () => {
		await born();
		const statements: string[] = [];
		const logged = new Kysely<AppDatabase>({
			dialect: new PostgresDialect({ pool: h.pool() as never }),
			log: (event) => {
				statements.push(event.query.sql);
			},
		});
		__setAppDbForTests(logged);
		try {
			expect((await readFirstPublishStates(viewerScope)).size).toBe(1);
		} finally {
			__setAppDbForTests(h.db());
		}
		expect(statements.length).toBeGreaterThan(0);
		expect(
			statements.some((one) => one.includes("first_publish_changes")),
		).toBe(true);
		expect(statements.some((one) => one.includes("source_gzip"))).toBe(false);
	});

	it("is shown on the Publishing card while the deployment stands, and not once it is ended", async () => {
		const birth = await born();
		vi.mocked(getSession).mockResolvedValue({ user: { id: VIEWER } } as never);
		const before = await readDeploymentsAction(APP);
		if (!before.success) throw new Error(before.message);
		expect(before.data.map((view) => view.firstPublish)).toEqual([
			{
				ids: ["forms-and-settings-rewritten"],
				touchesWorkers: false,
				of: "first-publish",
			},
		]);

		await stopHere(birth.scope, TARGET);
		expect((await readDeployment(birth.scope, TARGET))?.active).toEqual([]);
		const after = await readDeploymentsAction(APP);
		if (!after.success) throw new Error(after.message);
		expect(after.data.map((view) => view.firstPublish)).toEqual([null]);
	});
});
