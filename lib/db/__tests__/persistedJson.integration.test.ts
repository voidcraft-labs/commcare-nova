import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain/prose";
import {
	__setStrictAppLoadAfterRootReadHookForTests,
	listApps,
	listDeletedApps,
	loadApp,
} from "../apps";
import {
	PersistedJsonRejectedError,
	parsePersistedJsonText,
} from "../persistedJson";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("persisted_json_");

afterEach(() => {
	__setStrictAppLoadAfterRootReadHookForTests(null);
});

function validBlueprint(appName = "Stored app") {
	return buildDoc({
		appName,
		modules: [
			{
				name: "Before module",
				forms: [
					{
						name: "Survey",
						type: "survey",
						fields: [
							f({
								kind: "text",
								id: "name",
								label: proseText("Name"),
							}),
						],
					},
				],
			},
		],
	});
}

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("PostgreSQL persisted JSON boundary", () => {
	it("admits PostgreSQL's expanded exponent values by their exact text", async () => {
		const row = (
			await sql<{
				thousand: string;
				tenthMillionth: string;
				minimum: string;
				scaled: string;
			}>`
				SELECT
					('1e3'::jsonb)::text AS thousand,
					('1e-7'::jsonb)::text AS "tenthMillionth",
					('5e-324'::jsonb)::text AS minimum,
					('1.230e2'::jsonb)::text AS scaled
			`.execute(h.db())
		).rows[0];
		expect(row).toBeDefined();
		expect(row?.thousand).toBe("1000");
		expect(parsePersistedJsonText(row?.thousand ?? "")).toBe(1000);
		expect(parsePersistedJsonText(row?.tenthMillionth ?? "")).toBe(1e-7);
		expect(parsePersistedJsonText(row?.minimum ?? "")).toBe(Number.MIN_VALUE);
		expect(row?.scaled).toBe("123.0");
		expect(() => parsePersistedJsonText(row?.scaled ?? "")).toThrow(
			PersistedJsonRejectedError,
		);
	});

	it("rejects an unsafe number before strict Blueprint schema assembly", async () => {
		const appId = await h.seedAppWithBlueprint(
			validBlueprint("Unsafe carrier"),
		);
		await sql`
			UPDATE apps
			SET case_types = '[9007199254740993]'::jsonb
			WHERE id = ${appId}
		`.execute(h.db());
		await expect(loadApp(appId)).rejects.toBeInstanceOf(
			PersistedJsonRejectedError,
		);
	});

	it("rejects an unsafe persisted app sequence without rounding it", async () => {
		const appId = await h.seedAppWithBlueprint(
			validBlueprint("Unsafe sequence"),
		);
		await sql`
			UPDATE apps
			SET mutation_seq = 9007199254740992
			WHERE id = ${appId}
		`.execute(h.db());
		await expect(loadApp(appId)).rejects.toThrow(/safe-integer range/);
	});

	it("rejects a structurally parseable persisted app that fails the absolute gate", async () => {
		const appId = await h.seedAppWithBlueprint(validBlueprint());
		await h
			.db()
			.updateTable("apps")
			.set({ app_name: "", app_name_lower: "" })
			.where("id", "=", appId)
			.execute();

		await expect(loadApp(appId)).rejects.toThrow(
			/absolute commit gate \(EMPTY_APP_NAME\)/,
		);
	});

	it("loads root and entities from one transaction-consistent version", async () => {
		const initial = validBlueprint("Before app");
		const moduleUuid = initial.moduleOrder[0];
		if (moduleUuid === undefined) {
			throw new Error("validBlueprint fixture must contain one module");
		}
		const appId = await h.seedAppWithBlueprint(initial);
		const rootRead = deferredVoid();
		const continueLoad = deferredVoid();
		__setStrictAppLoadAfterRootReadHookForTests(async (hookAppId) => {
			if (hookAppId !== appId) return;
			rootRead.resolve();
			await continueLoad.promise;
		});

		const loadPromise = loadApp(appId);
		await rootRead.promise;
		let writerSettled = false;
		const writerPromise = h
			.db()
			.transaction()
			.execute(async (tx) => {
				await tx
					.updateTable("apps")
					.set({
						app_name: "After app",
						app_name_lower: "after app",
					})
					.where("id", "=", appId)
					.execute();
				await sql`
					UPDATE blueprint_entities
					SET data = jsonb_set(
						data,
						'{name}',
						to_jsonb(${"After module"}::text)
					)
					WHERE app_id = ${appId}
						AND uuid = ${moduleUuid}
				`.execute(tx);
			})
			.finally(() => {
				writerSettled = true;
			});

		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(writerSettled).toBe(false);
			continueLoad.resolve();
			const loaded = await loadPromise;
			expect(loaded?.app_name).toBe("Before app");
			expect(loaded?.blueprint.modules[moduleUuid]?.name).toBe("Before module");
			await writerPromise;
			const after = await loadApp(appId);
			expect(after?.app_name).toBe("After app");
			expect(after?.blueprint.modules[moduleUuid]?.name).toBe("After module");
		} finally {
			__setStrictAppLoadAfterRootReadHookForTests(null);
			continueLoad.resolve();
			await writerPromise.catch(() => undefined);
		}
	});

	it("lists and trashes apps without letting pg parse case_types", async () => {
		const projectId = "project-list-carrier";
		const appId = await h.seedApp({
			app_name: "Unsafe summary carrier",
			project_id: projectId,
		});
		await sql`
			UPDATE apps
			SET case_types = '[9007199254740993]'::jsonb
			WHERE id = ${appId}
		`.execute(h.db());

		const active = await listApps(projectId, {
			limit: 10,
			sort: "updated_desc",
		});
		expect(active.apps.map((app) => app.id)).toEqual([appId]);

		const deletedAt = new Date();
		await h
			.db()
			.updateTable("apps")
			.set({
				deleted_at: deletedAt,
				recoverable_until: new Date(deletedAt.getTime() + 60_000),
			})
			.where("id", "=", appId)
			.execute();
		const deleted = await listDeletedApps(projectId, { limit: 10 });
		expect(deleted.apps.map((app) => app.id)).toEqual([appId]);
	});
});
