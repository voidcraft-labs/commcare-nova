import { sql } from "kysely";
import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
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
		let rootWasRead = false;
		const continueLoad = deferredVoid();
		__setStrictAppLoadAfterRootReadHookForTests(async (hookAppId) => {
			if (hookAppId !== appId) return;
			rootWasRead = true;
			await continueLoad.promise;
		});
		const writer = new Client({ connectionString: h.uri() });
		const observer = new Client({ connectionString: h.uri() });
		const loadOutcome = loadApp(appId).then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		let writerOutcome:
			| Promise<{ error: unknown } | { value: undefined }>
			| undefined;
		try {
			await vi.waitFor(() => expect(rootWasRead).toBe(true));
			await writer.connect();
			await observer.connect();
			const writerPid = (
				await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
			).rows[0].pid;
			writerOutcome = (async () => {
				await writer.query("BEGIN");
				await writer.query(
					"UPDATE apps SET app_name = $1, app_name_lower = $2 WHERE id = $3",
					["After app", "after app", appId],
				);
				await writer.query(
					"UPDATE blueprint_entities SET data = jsonb_set(data, '{name}', to_jsonb($1::text)) WHERE app_id = $2 AND uuid = $3",
					["After module", appId, moduleUuid],
				);
				await writer.query("COMMIT");
			})().then(
				() => ({ value: undefined }),
				(error: unknown) => ({ error }),
			);
			await vi.waitFor(async () => {
				const result = await observer.query<{ blocked: boolean }>(
					"SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked",
					[writerPid],
				);
				expect(result.rows[0]?.blocked).toBe(true);
			});

			continueLoad.resolve();
			const loaded = await loadOutcome;
			if ("error" in loaded) throw loaded.error;
			expect(loaded.value?.app_name).toBe("Before app");
			expect(loaded.value?.blueprint.modules[moduleUuid]?.name).toBe(
				"Before module",
			);
			const written = await writerOutcome;
			if ("error" in written) throw written.error;
			const after = await loadApp(appId);
			expect(after?.app_name).toBe("After app");
			expect(after?.blueprint.modules[moduleUuid]?.name).toBe("After module");
		} finally {
			__setStrictAppLoadAfterRootReadHookForTests(null);
			continueLoad.resolve();
			await loadOutcome;
			await writerOutcome;
			await Promise.all([writer.end(), observer.end()]);
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
