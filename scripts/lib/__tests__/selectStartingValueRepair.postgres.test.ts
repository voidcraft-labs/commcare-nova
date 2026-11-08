import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { loadApp } from "@/lib/db/apps";
import { createLookupTable } from "@/lib/lookup/service";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { loadPersistedBlueprintSnapshot } from "../loadPersistedBlueprint";
import { repairAuthoringBaseline } from "../repairAuthoringBaselines";
import {
	inspectSelectStartingValues,
	migrateSelectStartingValues,
	repairedSelectStartingValues,
	type SelectStartingValueRepair,
} from "../selectStartingValueRepair";

const h = setupAppStateTestDb("select_start_repair_");
const FIELD = testUuid("historical-choice");
async function legacy() {
	// Historical data intentionally predates the strengthened admission rule.
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
									id: "stage",
									kind: "single_select",
									options: [
										{ value: "yes", label: "Yes" },
										{ value: "no", label: "No" },
									],
									default_value: "if(true(), 'old', 'yes')",
								}),
							],
						},
					],
				},
			],
		}),
	);
	await repairAuthoringBaseline(appId);
	const snapshot = await loadPersistedBlueprintSnapshot(appId);
	if (!snapshot) throw new Error("Missing source");
	const patches: SelectStartingValueRepair["patches"] = [
		{
			fieldUuid: FIELD,
			beforeDigest: canonicalJsonDigest(snapshot.blueprint.fields[FIELD]),
			change: { kind: "remove-starting-value" },
		},
	];
	return {
		appId,
		expectedBaseSeq: snapshot.mutationSeq,
		baseDigest: canonicalJsonDigest(snapshot.blueprint),
		targetDigest: canonicalJsonDigest(
			repairedSelectStartingValues(snapshot.blueprint, patches),
		),
		reason: "Ask for an explicit current answer",
		patches,
	};
}
it("repairs an invalid historical app once, with an independently reloadable history", async () => {
	const plan = await legacy();
	const inspected = await inspectSelectStartingValues(plan.appId);
	expect(inspected.baseDigest).toBe(plan.baseDigest);
	expect(inspected.lookupContext.kind).toBe("available");
	expect(inspected.findings).toEqual([
		expect.objectContaining({ code: "SELECT_DEFAULT_NOT_AN_OPTION" }),
	]);
	await migrateSelectStartingValues(plan);
	expect((await inspectSelectStartingValues(plan.appId)).findings).toEqual([]);
	const loaded = await loadApp(plan.appId);
	expect(loaded?.blueprint.fields[FIELD]).not.toHaveProperty("default_value");
	expect(await migrateSelectStartingValues(plan)).toMatchObject({
		status: "already-applied",
	});
	const changes = await h
		.db()
		.selectFrom("app_changes")
		.selectAll()
		.where("app_id", "=", plan.appId)
		.execute();
	expect(changes).toHaveLength(2);
	expect(
		changes.find((change) => change.kind === "blueprint-migration"),
	).toMatchObject({
		kind: "blueprint-migration",
		actor_id: "system:select-starting-values",
	});
});
it("refuses stale plans and an invalid target without a partial write", async () => {
	const plan = await legacy();
	await expect(
		migrateSelectStartingValues({ ...plan, baseDigest: "stale" }),
	).rejects.toThrow("reviewed repair basis");
	await expect(
		migrateSelectStartingValues({ ...plan, targetDigest: "wrong" }),
	).rejects.toThrow("target does not match");
	const snapshot = await loadPersistedBlueprintSnapshot(plan.appId);
	expect(snapshot?.mutationSeq).toBe(plan.expectedBaseSeq);
	expect(snapshot?.blueprint.fields[FIELD]).toHaveProperty("default_value");
	expect(
		await h
			.db()
			.selectFrom("app_changes")
			.selectAll()
			.where("app_id", "=", plan.appId)
			.execute(),
	).toHaveLength(1);
});
it("does not repair while a generation holds the app", async () => {
	const plan = await legacy();
	await h
		.db()
		.updateTable("apps")
		.set({
			lock_run_id: "running",
			lock_actor_user_id: "owner-test",
			lock_expire_at: new Date(Date.now() + 60000),
		})
		.where("id", "=", plan.appId)
		.execute();
	await expect(migrateSelectStartingValues(plan)).rejects.toThrow(
		"still holds this app",
	);
	expect((await loadPersistedBlueprintSnapshot(plan.appId))?.mutationSeq).toBe(
		plan.expectedBaseSeq,
	);
});

it("finds lookup-derived starting values and refuses missing definitions", async () => {
	const projectId = "starting-value-project";
	const table = await createLookupTable(
		{ projectId, actorId: "owner-test", role: "owner" },
		{
			name: "Statuses",
			tag: "statuses",
			columns: [{ wireName: "status", label: "Status", dataType: "text" }],
		},
	);
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
								id: "stage",
								kind: "single_select",
								options: [{ value: "yes", label: "Yes" }],
							}),
						],
					},
				],
			},
		],
	});
	const field = doc.fields[FIELD];
	if (field.kind !== "single_select")
		throw new Error("Expected choice question");
	field.default_value = {
		kind: "table-lookup",
		tableId: table.id,
		resultColumnId: table.columns[0].id,
		where: { kind: "match-all" },
	};
	const appId = await h.seedAppWithBlueprint(doc, { projectId });
	expect((await inspectSelectStartingValues(appId)).findings).toEqual([
		expect.objectContaining({ code: "SELECT_DEFAULT_VALUES_UNBOUNDED" }),
	]);
	// An old app can retain a reference to a table outside its Project.
	const foreignAppId = await h.seedAppWithBlueprint(doc, {
		projectId: "another-project",
	});
	await expect(inspectSelectStartingValues(foreignAppId)).rejects.toThrow(
		"Lookup definitions are incomplete",
	);
});
