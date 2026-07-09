/**
 * commitGuardedBatch — the seq-recompute guarantee, against a REAL Postgres.
 *
 * The durable-stream ordering property is: `mutation_seq` is a LITERAL
 * `Number(fresh.mutation_seq) + 1` READ INSIDE the transaction closure under the
 * app-row lock (`lockAppRow` → `SELECT … FOR UPDATE`), so it is recomputed off
 * whatever the row currently carries and can never reuse a value cached OUTSIDE
 * the closure — a regression that cached it would leave a GAP or DUPLICATE.
 *
 * The Firestore-era unit suite drove a fake `runTransaction` twice to SIMULATE an
 * abort-retry, because the emulator livelocked on real 2-way contention. On
 * Postgres the app-row `FOR UPDATE` lock makes the contention deterministic, so
 * this drives it FOR REAL: two concurrent commits over separate connections
 * serialize behind the row lock, and the second re-reads the advanced seq — a
 * strictly stronger proof than the fake. (`withAppTx`'s deadlock/serialization
 * retry loop is unit-tested in `withAppTx.test.ts`; the serial gap-free run is in
 * `commitGuardedBatch.integration.test.ts`.)
 */

import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { __setAppDbForTests, type AppDatabase } from "../pg";
import { setupAppStateTestDb } from "./appStateTestDb";

const OWNER = "user-owner";

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
								label: "Name",
								case_property_on: "patient",
							}),
							f({
								kind: "text",
								id: "village",
								label: "Village",
								case_property_on: "patient",
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
					{ name: "case_name", label: "Name" },
					{ name: "village", label: "Village" },
				],
			},
		],
	});
}

function villageUuid(doc: BlueprintDoc): string {
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
			patch: { label },
		} as Mutation,
	];
}

async function readSeq(appId: string): Promise<number> {
	return Number((await h.readAppRow(appId))?.mutation_seq);
}

describe("commitGuardedBatch — seq recompute", () => {
	it("computes the literal (fresh + 1) off whatever mutation_seq the row carries (no cached zero)", async () => {
		const { commitGuardedBatch } = await import("../apps");
		const doc = minDoc();
		// A null-project app (owner path — reauth passes on owner === actor).
		const appId = await h.seedAppWithBlueprint(doc, {
			projectId: null,
			owner: OWNER,
		});
		// A row already advanced by 41 prior commits.
		await h
			.db()
			.updateTable("apps")
			.set({ mutation_seq: 41 })
			.where("id", "=", appId)
			.execute();

		const result = await commitGuardedBatch({
			appId,
			batchId: crypto.randomUUID(),
			mutations: renameVillageLabel(doc, "Home"),
			actorUserId: OWNER,
			kind: "autosave",
		});

		expect(result.seq).toBe(42);
		expect(await readSeq(appId)).toBe(42);
	});

	it("two concurrent commits produce gap-free seqs — each re-reads the advanced seq under the app-row lock", async () => {
		const { commitGuardedBatch } = await import("../apps");
		const doc = minDoc();
		const appId = await h.seedAppWithBlueprint(doc, {
			projectId: null,
			owner: OWNER,
		});

		// A multi-connection pool so the two commits genuinely contend on the app
		// row's `FOR UPDATE` lock (the harness's per-test pool is max: 1).
		const contendPool = new Pool({ connectionString: h.uri(), max: 4 });
		contendPool.on("error", () => {});
		__setAppDbForTests(
			new Kysely<AppDatabase>({
				dialect: new PostgresDialect({
					pool: contendPool as unknown as PostgresPool,
				}),
			}),
		);
		try {
			const [a, b] = await Promise.all([
				commitGuardedBatch({
					appId,
					batchId: crypto.randomUUID(),
					mutations: renameVillageLabel(doc, "Home A"),
					actorUserId: OWNER,
					kind: "autosave",
				}),
				commitGuardedBatch({
					appId,
					batchId: crypto.randomUUID(),
					mutations: renameVillageLabel(doc, "Home B"),
					actorUserId: OWNER,
					kind: "autosave",
				}),
			]);

			// The row lock serialized them: distinct, gap-free seqs (order arbitrary).
			expect([a.seq, b.seq].sort()).toEqual([1, 2]);
		} finally {
			await contendPool.end();
			// Restore getAppDb to the harness's per-test pool for the read below +
			// any later test's setup before its own beforeEach re-injects.
			__setAppDbForTests(
				new Kysely<AppDatabase>({
					dialect: new PostgresDialect({
						pool: h.pool() as unknown as PostgresPool,
					}),
				}),
			);
		}

		// Exactly two stream rows, seqs 1 and 2 with no gap/dup, and the counter
		// landed at 2.
		const rows = await h
			.db()
			.selectFrom("accepted_mutations")
			.select("seq")
			.where("app_id", "=", appId)
			.orderBy("seq")
			.execute();
		expect(rows.map((r) => Number(r.seq))).toEqual([1, 2]);
		expect(await readSeq(appId)).toBe(2);
	});
});
