import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { loadApp } from "@/lib/db/apps";
import { sessionUser, term } from "@/lib/domain/expression/builders";
import { loadPersistedBlueprintSnapshot } from "../loadPersistedBlueprint";
import { repairAuthoringBaseline } from "../repairAuthoringBaselines";
import {
	applyUndeclaredWorkerFieldRepair,
	inspectUndeclaredWorkerFields,
	UNDECLARED_WORKER_FIELD_ACTOR,
	type UndeclaredWorkerFieldPlan,
} from "../undeclaredWorkerFieldMigration";
import { undeclaredWorkerFieldPropertyUuid } from "../undeclaredWorkerFieldRepair";

const h = setupAppStateTestDb("undeclared_worker_field_");
const FIELD = testUuid("historical-worker-read");

/** A saved app whose Hidden Value reads the worker's `district` from the
 *  session by name without declaring it, as apps saved before the gate do. */
async function historicalApp(): Promise<string> {
	const appId = await h.seedAppWithBlueprint(
		buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Survey",
							type: "survey",
							fields: [
								f({
									uuid: FIELD,
									kind: "hidden",
									id: "district_copy",
									calculate: term(sessionUser("district")),
								}),
							],
						},
					],
				},
			],
		}),
	);
	await repairAuthoringBaseline(appId);
	return appId;
}

async function planOf(appId: string): Promise<UndeclaredWorkerFieldPlan> {
	const inspection = await inspectUndeclaredWorkerFields(appId);
	if (inspection.kind !== "planned")
		throw new Error(`Expected a plan, got ${inspection.kind}.`);
	return inspection.plan;
}

async function changesOf(appId: string) {
	return h
		.db()
		.selectFrom("app_changes")
		.select(["seq", "kind", "actor_id"])
		.where("app_id", "=", appId)
		.orderBy("seq")
		.execute();
}

it("repairs a saved app once, through the change log, and finds nothing after", async () => {
	const appId = await historicalApp();
	const plan = await planOf(appId);
	expect(plan).toMatchObject({ declaredCount: 1, reboundReads: 1 });

	const written = await applyUndeclaredWorkerFieldRepair(plan);
	expect(written).toEqual({
		status: "committed",
		seq: plan.expectedBaseSeq + 1,
	});
	const loaded = await loadApp(appId);
	const district = undeclaredWorkerFieldPropertyUuid(appId, "district");
	expect(loaded?.blueprint.userProperties?.[district]).toEqual({
		uuid: district,
		slug: "district",
		label: "district",
	});
	expect(loaded?.blueprint.fields[FIELD]).toMatchObject({
		calculate: {
			kind: "term",
			term: { kind: "session-user-property", userPropertyUuid: district },
		},
	});
	expect((await changesOf(appId)).at(-1)).toEqual({
		seq: String(plan.expectedBaseSeq + 1),
		kind: "blueprint-migration",
		actor_id: UNDECLARED_WORKER_FIELD_ACTOR,
	});

	expect(await inspectUndeclaredWorkerFields(appId)).toEqual({
		kind: "clean",
	});
	expect(await applyUndeclaredWorkerFieldRepair(plan)).toEqual({
		status: "already-applied",
		seq: plan.expectedBaseSeq + 1,
	});
	expect(await changesOf(appId)).toHaveLength(2);
});

it("repairs an app that declares the field it reads by name", async () => {
	const declared = testUuid("declared-worker-district");
	const doc = buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Survey",
						type: "survey",
						fields: [
							f({
								uuid: FIELD,
								kind: "hidden",
								id: "district_copy",
								calculate: term(sessionUser("district")),
							}),
						],
					},
				],
			},
		],
	});
	// Declared after the build, so the read stays by name, as an app saved
	// before the gate holds it.
	doc.userProperties = {
		[declared]: { uuid: declared, slug: "district", label: "District" },
	};
	doc.userPropertyOrder = [declared];
	const appId = await h.seedAppWithBlueprint(doc);
	await repairAuthoringBaseline(appId);

	const plan = await planOf(appId);
	expect(plan).toMatchObject({ declaredCount: 0, reboundReads: 1 });
	expect(await applyUndeclaredWorkerFieldRepair(plan)).toMatchObject({
		status: "committed",
	});
	expect((await loadApp(appId))?.blueprint.fields[FIELD]).toMatchObject({
		calculate: {
			kind: "term",
			term: { kind: "session-user-property", userPropertyUuid: declared },
		},
	});
	expect(await inspectUndeclaredWorkerFields(appId)).toEqual({
		kind: "clean",
	});
});

it("skips an app that changed since its plan and writes nothing", async () => {
	const appId = await historicalApp();
	const plan = await planOf(appId);
	expect(
		await applyUndeclaredWorkerFieldRepair({ ...plan, baseDigest: "stale" }),
	).toEqual({ status: "skipped-changed" });
	expect(
		await applyUndeclaredWorkerFieldRepair({
			...plan,
			expectedBaseSeq: plan.expectedBaseSeq - 1,
		}),
	).toEqual({ status: "skipped-changed" });
	const snapshot = await loadPersistedBlueprintSnapshot(appId);
	expect(snapshot?.mutationSeq).toBe(plan.expectedBaseSeq);
	expect(snapshot?.blueprint.userProperties).toBeUndefined();
	expect(await changesOf(appId)).toHaveLength(1);
});

it("skips an app a run holds", async () => {
	const appId = await historicalApp();
	const plan = await planOf(appId);
	await h
		.db()
		.updateTable("apps")
		.set({
			lock_run_id: "running",
			lock_actor_user_id: "owner-test",
			lock_expire_at: new Date(Date.now() + 60000),
		})
		.where("id", "=", appId)
		.execute();
	expect(await applyUndeclaredWorkerFieldRepair(plan)).toEqual({
		status: "skipped-held",
	});
	expect((await loadPersistedBlueprintSnapshot(appId))?.mutationSeq).toBe(
		plan.expectedBaseSeq,
	);
});
