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
 *
 * The kernel is also the boundary a forged save meets for held placements:
 * an editor's batch may move a hold its own edit stranded, or restore the
 * hold the latest recording wrote, and nothing else, whatever the client
 * sends.
 */

import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { writeHqRoundTripHorizon } from "@/lib/agent/change-set/__tests__/foldHorizonFixture";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { placementTargetKey } from "@/lib/doc/placementHolds";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import type { LookupRevision } from "@/lib/lookup/types";
import { replayCanonicalAppChangeSuffix } from "../canonicalMutationFold";
import { BlueprintCommitRejectedError } from "../commitGuard";
import { __setAppDbForTests, type AppDatabase } from "../pg";
import { PLACEMENT_CHANGE_REFUSAL } from "../placementAuthority";
import { readRecordedPlacementHolds } from "../placementRecords";
import { commitGuardedBatchProposal as commitGuardedBatch } from "./admittedWriterTestHelpers";
import { setupAppStateTestDb } from "./appStateTestDb";
import {
	addKid,
	type HeldPlacementApp,
	heldPlacementApp,
	holdOperation,
	holdPlacements,
	operationHold,
	removeKid,
	villageOnlyIfChanged,
} from "./heldPlacementApp";

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

describe("commitGuardedBatch — held placements", () => {
	const ACTOR = OWNER;

	async function seedHeld(app: HeldPlacementApp): Promise<string> {
		return h.seedAppWithBlueprint(app.doc, {
			projectId: PROJECT,
			owner: ACTOR,
		});
	}

	function autosave(appId: string, mutations: readonly Mutation[]) {
		return commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId: crypto.randomUUID(),
			mutations,
			actorUserId: ACTOR,
			kind: "autosave",
		});
	}

	async function heldOn(
		appId: string,
		app: HeldPlacementApp,
		operationUuid: string,
	) {
		const { loadApp } = await import("../apps");
		const saved = await loadApp(appId);
		return saved?.blueprint.forms[app.formUuid]?.caseOperations?.find(
			(op) => op.uuid === operationUuid,
		)?.placement;
	}

	async function changeCount(appId: string): Promise<number> {
		const rows = await h
			.db()
			.selectFrom("app_changes")
			.select("seq")
			.where("app_id", "=", appId)
			.execute();
		return rows.length;
	}

	/** Refused with the placement sentence, with nothing written. */
	async function expectRefusedUnwritten(
		appId: string,
		mutations: readonly Mutation[],
	): Promise<void> {
		const seq = await readSeq(appId);
		const changes = await changeCount(appId);
		await expect(autosave(appId, mutations)).rejects.toEqual(
			new BlueprintCommitRejectedError(PLACEMENT_CHANGE_REFUSAL, {
				placementRule: true,
			}),
		);
		expect(await readSeq(appId)).toBe(seq);
		expect(await changeCount(appId)).toBe(changes);
	}

	/** The own case held at Save to Case, behind a fold baseline that
	 *  recorded it there, then moved to its basic slot by an edit that keeps
	 *  only changed answers. */
	async function movedBehindBaseline(app: HeldPlacementApp): Promise<string> {
		const appId = await seedHeld(app);
		await writeHqRoundTripHorizon(h.db(), appId, "Held placements");
		await autosave(appId, [
			villageOnlyIfChanged(app, true),
			holdPlacements(operationHold(app, app.own.uuid, app.ownBasic)),
		]);
		expect(await heldOn(appId, app, app.own.uuid)).toEqual(app.ownBasic);
		return appId;
	}

	it("refuses an autosave that gains a hold, writing nothing", async () => {
		const app = heldPlacementApp();
		const appId = await seedHeld(app);
		await expectRefusedUnwritten(appId, [
			holdPlacements(operationHold(app, app.own.uuid, app.ownSaveToCase)),
		]);
		expect(await heldOn(appId, app, app.own.uuid)).toBeUndefined();
	});

	it("refuses an autosave that replaces an expressible hold", async () => {
		const app = heldPlacementApp((a) =>
			holdOperation(a, a.own.uuid, a.ownSaveToCase),
		);
		const appId = await seedHeld(app);
		await expectRefusedUnwritten(appId, [
			holdPlacements(operationHold(app, app.own.uuid, app.ownBasic)),
		]);
		expect(await heldOn(appId, app, app.own.uuid)).toEqual(app.ownSaveToCase);
	});

	it("admits an autosave that moves a hold its edit made inexpressible", async () => {
		const app = heldPlacementApp((a) =>
			holdOperation(a, a.own.uuid, a.ownSaveToCase),
		);
		const appId = await seedHeld(app);
		const result = await autosave(appId, [
			villageOnlyIfChanged(app, true),
			holdPlacements(operationHold(app, app.own.uuid, app.ownBasic)),
		]);
		expect(result.seq).toBe(1);
		expect(await heldOn(appId, app, app.own.uuid)).toEqual(app.ownBasic);
	});

	it("admits an autosave restoring the hold the greatest fold baseline's snapshot holds", async () => {
		const app = heldPlacementApp((a) =>
			holdOperation(a, a.own.uuid, a.ownSaveToCase),
		);
		const appId = await movedBehindBaseline(app);
		await autosave(appId, [
			villageOnlyIfChanged(app, null),
			holdPlacements(operationHold(app, app.own.uuid, app.ownSaveToCase)),
		]);
		expect(await heldOn(appId, app, app.own.uuid)).toEqual(app.ownSaveToCase);
	});

	it("admits an autosave re-creating a removed held operation with its recorded hold", async () => {
		const app = heldPlacementApp((a) =>
			holdOperation(a, a.kid.uuid, a.kidSaveToCase),
		);
		const appId = await seedHeld(app);
		await writeHqRoundTripHorizon(h.db(), appId, "Held placements");
		await autosave(appId, [removeKid(app)]);
		expect(await heldOn(appId, app, app.kid.uuid)).toBeUndefined();

		await autosave(appId, [
			addKid(app),
			holdPlacements(operationHold(app, app.kid.uuid, app.kidSaveToCase)),
		]);
		expect(await heldOn(appId, app, app.kid.uuid)).toEqual(app.kidSaveToCase);
	});

	it("refuses an autosave restoring an editor's earlier move", async () => {
		const app = heldPlacementApp((a) =>
			holdOperation(a, a.own.uuid, a.ownSaveToCase),
		);
		const appId = await movedBehindBaseline(app);
		await autosave(appId, [
			villageOnlyIfChanged(app, null),
			holdPlacements(operationHold(app, app.own.uuid, app.ownSaveToCase)),
		]);
		// The basic slot was the editor's move, not a recording, and Save to
		// Case can still hold the own case.
		await expectRefusedUnwritten(appId, [
			holdPlacements(operationHold(app, app.own.uuid, app.ownBasic)),
		]);
		expect(await heldOn(appId, app, app.own.uuid)).toEqual(app.ownSaveToCase);
	});

	it("admits a synthetic migration that gains a hold", async () => {
		const app = heldPlacementApp();
		const appId = await seedHeld(app);
		const { appendSyntheticBatch, loadApp } = await import("../apps");
		const current = await loadApp(appId);
		if (current === null) throw new Error("The seeded app loads.");
		const target = structuredClone(current.blueprint);
		const own = target.forms[app.formUuid]?.caseOperations?.find(
			(op) => op.uuid === app.own.uuid,
		);
		if (own === undefined) throw new Error("The seeded form holds its case.");
		own.placement = app.ownSaveToCase;

		const result = await appendSyntheticBatch({
			appId,
			expectedBaseSeq: current.mutation_seq,
			targetDoc: target,
			authority: {
				kind: "system",
				actorId: "system:placement-test",
				reason: "Record where a publish keeps the own case",
			},
		});
		expect(result.kind).toBe("committed");
		expect(await heldOn(appId, app, app.own.uuid)).toEqual(app.ownSaveToCase);
		const ownKey = placementTargetKey({
			target: "case-operation",
			formUuid: app.formUuid,
			operationUuid: app.own.uuid,
		});
		expect(await readRecordedPlacementHolds(h.db(), appId, [ownKey])).toEqual(
			new Map([[ownKey, operationHold(app, app.own.uuid, app.ownSaveToCase)]]),
		);
	});
});
