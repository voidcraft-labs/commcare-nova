/**
 * commitGuardedBatch — the seq-recompute guarantee, against a REAL Postgres.
 *
 * The durable-stream ordering property is: `mutation_seq` is a LITERAL
 * `Number(fresh.mutation_seq) + 1` READ INSIDE the transaction closure under the
 * app-row lock (`lockAppRow` → `SELECT … FOR UPDATE`), so it is recomputed off
 * whatever the row currently carries and can never reuse a value cached OUTSIDE
 * the closure — a regression that cached it would leave a GAP or DUPLICATE.
 *
 * The app-row `FOR UPDATE` lock makes the contention deterministic, so this
 * drives it FOR REAL: two concurrent commits over separate connections
 * serialize behind the row lock, and the second re-reads the advanced seq.
 * (`withAppTx`'s deadlock/serialization retry loop is unit-tested in
 * `withAppTx.test.ts`; the serial gap-free run is in
 * `commitGuardedBatchTransactions.postgres.test.ts`.)
 */

import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import type { LookupRevision } from "@/lib/lookup/types";
import { replayCanonicalAppChangeSuffix } from "../canonicalMutationFold";
import { __setAppDbForTests, type AppDatabase } from "../pg";
import { commitGuardedBatchProposal as commitGuardedBatch } from "./admittedWriterTestHelpers";
import { setupAppStateTestDb } from "./appStateTestDb";

const OWNER = "user-owner";
const PROJECT = "project-test";

const h = setupAppStateTestDb("commit_unit_");

/** A minimal valid registration doc — the REAL commit verdict runs against it. */
function minDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Test",
		modules: [
			{
				name: "Mod",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Form",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: {
									caseType: "patient",
									property: "case_name",
								},
							}),
							f({
								kind: "text",
								id: "village",
								label: proseText("Village"),
								caseWrite: {
									caseType: "patient",
									property: "village",
								},
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "village", label: proseText("Village") },
				],
			},
		],
	});
}

function villageUuid(doc: BlueprintDoc): Uuid {
	const uuid = Object.values(doc.fields).find(
		(fld) => fld.id === "village",
	)?.uuid;
	if (!uuid) throw new Error("village field missing");
	return uuid;
}

function renameVillageLabel(doc: BlueprintDoc, label: string): Mutation[] {
	return [
		{
			kind: "updateField",
			uuid: villageUuid(doc),
			targetKind: "text",
			patch: { label: proseText(label) },
		} as Mutation,
	];
}

async function readSeq(appId: string): Promise<number> {
	return Number((await h.readAppRow(appId))?.mutation_seq);
}

describe("commitGuardedBatch — seq recompute", () => {
	it("computes the literal (fresh + 1) off whatever mutation_seq the row carries (no cached zero)", async () => {
		const doc = minDoc();
		const appId = await h.seedAppWithBlueprint(doc, {
			projectId: PROJECT,
			owner: OWNER,
		});
		// A row already advanced by 41 prior commits.
		await h.withTransaction((tx) =>
			tx
				.updateTable("apps")
				.set({ mutation_seq: 41 })
				.where("id", "=", appId)
				.execute(),
		);

		const result = await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId: crypto.randomUUID(),
			mutations: renameVillageLabel(doc, "Home"),
			actorUserId: OWNER,
			kind: "autosave",
		});

		expect(result.seq).toBe(42);
		expect(await readSeq(appId)).toBe(42);
	});

	it("two concurrent commits produce gap-free seqs — each re-reads the advanced seq under the app-row lock", async () => {
		const doc = minDoc();
		const appId = await h.seedAppWithBlueprint(doc, {
			projectId: PROJECT,
			owner: OWNER,
		});

		// A multi-connection pool so the two commits genuinely contend on the app
		// row's `FOR UPDATE` lock (the harness's per-test pool is max: 1).
		const contendPool = new Pool({ connectionString: h.uri(), max: 4 });
		__setAppDbForTests(
			new Kysely<AppDatabase>({
				dialect: new PostgresDialect({
					pool: contendPool as unknown as PostgresPool,
				}),
			}),
		);
		try {
			const outcomes = await Promise.allSettled([
				commitGuardedBatch({
					appId,
					expectedProjectId: PROJECT,
					batchId: crypto.randomUUID(),
					mutations: renameVillageLabel(doc, "Home A"),
					actorUserId: OWNER,
					kind: "autosave",
				}),
				commitGuardedBatch({
					appId,
					expectedProjectId: PROJECT,
					batchId: crypto.randomUUID(),
					mutations: renameVillageLabel(doc, "Home B"),
					actorUserId: OWNER,
					kind: "autosave",
				}),
			]);

			// Join both writers before teardown, including when one rejects.
			const results = outcomes.map((outcome) => {
				if (outcome.status === "rejected") throw outcome.reason;
				return outcome.value;
			});
			expect(results.map((result) => result.seq).sort()).toEqual([1, 2]);
		} finally {
			await contendPool.end();
			// Restore getAppDb to the harness's per-test pool for the read below +
			// any later test's setup before its own beforeEach re-injects.
			__setAppDbForTests(h.db());
		}

		// Exactly two stream rows, seqs 1 and 2 with no gap/dup, and the counter
		// landed at 2.
		const rows = await h
			.db()
			.selectFrom("app_changes")
			.select("seq")
			.where("app_id", "=", appId)
			.orderBy("seq")
			.execute();
		expect(rows.map((r) => Number(r.seq))).toEqual([1, 2]);
		expect(await readSeq(appId)).toBe(2);
	});
});

describe("commitGuardedBatch — app settings", () => {
	it("writes apps.app_settings and reads the row back as the same document", async () => {
		const doc = minDoc();
		const appId = await h.seedAppWithBlueprint(doc, {
			projectId: PROJECT,
			owner: OWNER,
		});

		await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId: crypto.randomUUID(),
			mutations: [
				{ kind: "setAppSettings", settings: { showIncompleteForms: true } },
			],
			actorUserId: OWNER,
			kind: "autosave",
		});

		const expected = { showSavedForms: false, showIncompleteForms: true };
		expect((await h.readAppRow(appId))?.app_settings).toEqual(expected);
		const { loadApp } = await import("../apps");
		const reloaded = await loadApp(appId);
		expect(reloaded?.blueprint).toEqual({
			...toPersistableDoc(doc),
			appId,
			appSettings: expected,
		});
	});

	it("stores where the app runs, clears it to the absent key, and folds to the same head from a baseline written before it", async () => {
		const doc = minDoc();
		const appId = await h.seedAppWithBlueprint(doc, {
			projectId: PROJECT,
			owner: OWNER,
		});
		const baselineSeq = await readSeq(appId);
		const narrow: Mutation[] = [
			{ kind: "setAppSettings", settings: { runsOnlyOn: "android" } },
		];
		const clear: Mutation[] = [
			{ kind: "setAppSettings", settings: { runsOnlyOn: null } },
		];
		const { loadApp } = await import("../apps");

		await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId: crypto.randomUUID(),
			mutations: narrow,
			actorUserId: OWNER,
			kind: "autosave",
		});
		const narrowed = {
			showSavedForms: false,
			showIncompleteForms: false,
			runsOnlyOn: "android",
		};
		expect((await h.readAppRow(appId))?.app_settings).toEqual(narrowed);
		expect((await loadApp(appId))?.blueprint.appSettings).toEqual(narrowed);

		await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId: crypto.randomUUID(),
			mutations: clear,
			actorUserId: OWNER,
			kind: "autosave",
		});
		const cleared = (await h.readAppRow(appId))?.app_settings;
		expect(cleared).toEqual({
			showSavedForms: false,
			showIncompleteForms: false,
		});
		expect(Object.hasOwn(cleared ?? {}, "runsOnlyOn")).toBe(false);
		const head = await loadApp(appId);

		// The seeded document holds no declaration, as every baseline stored
		// before the key existed holds none.
		const baseline = { ...toPersistableDoc(doc), appId };
		expect(Object.hasOwn(baseline.appSettings, "runsOnlyOn")).toBe(false);
		const row = (seq: number, mutations: readonly Mutation[]) => ({
			seq: String(seq),
			batch_id: `fold:${seq}`,
			run_id: null,
			actor_id: OWNER,
			kind: "autosave",
			mutationsText: JSON.stringify(mutations),
			from_project_id: null,
			to_project_id: null,
		});
		const folded = replayCanonicalAppChangeSuffix({
			baselineSnapshotText: JSON.stringify(baseline),
			baselineSeq,
			baselineProjectId: PROJECT,
			expectedHeadSeq: baselineSeq + 2,
			expectedFinalProjectId: PROJECT,
			suffix: [row(baselineSeq + 1, narrow), row(baselineSeq + 2, clear)],
			finalLookupContext: {
				kind: "available",
				projectId: PROJECT,
				projectRevision: "0" as LookupRevision,
				definitions: [],
			},
		});
		expect(folded.snapshot).toEqual(head?.blueprint);
	});
});
