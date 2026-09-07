import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { loadSchemaAdmittedAppForInspection } from "@/lib/db/apps";
import { opaqueXPathExpression } from "@/lib/domain";
import {
	listHiddenValueBothSourcesCandidateAppIds,
	runHiddenValueBothSourcesRepair,
} from "../lib/hiddenValueBothSourcesRepair";

const h = setupAppStateTestDb();

const FORM = testUuid("visit-form");
const BOTH = testUuid("both-sources");
const CALC_ONLY = testUuid("calc-only");

/** One offender (calculate + default_value) beside a calculate-only hidden
 *  and a text field. */
function fixture() {
	return buildDoc({
		appName: "Visits",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "survey",
						fields: [
							f({ kind: "text", id: "note", label: "Note" }),
							f({
								uuid: BOTH,
								kind: "hidden",
								id: "stamp",
								calculate: "today()",
								default_value: "''",
							}),
							f({
								uuid: CALC_ONLY,
								kind: "hidden",
								id: "calc",
								calculate: "1 + 1",
							}),
						],
					},
				],
			},
		],
	});
}

async function changeRows() {
	return h
		.db()
		.selectFrom("app_changes")
		.select(["app_id", "seq", "batch_id", "actor_id", "kind", "mutations"])
		.orderBy("app_id")
		.orderBy("seq")
		.execute();
}

it("writes one blueprint-migration row under the system actor that clears exactly default_value, advances mutation_seq by one, and reruns as a no-op", async () => {
	const id = await h.seedAppWithBlueprint(fixture(), { id: "repair" });
	const baseSeq = Number((await h.readAppRow(id))?.mutation_seq);

	// The dry run counts exactly what the write would touch and writes nothing.
	expect(await runHiddenValueBothSourcesRepair([id], { dryRun: true })).toEqual(
		{
			scannedApps: 1,
			repairedApps: 1,
			clearedFields: 1,
			blockedApps: [],
		},
	);
	expect(await changeRows()).toHaveLength(0);
	expect(Number((await h.readAppRow(id))?.mutation_seq)).toBe(baseSeq);

	const report = await runHiddenValueBothSourcesRepair([id]);
	expect(report).toEqual({
		scannedApps: 1,
		repairedApps: 1,
		clearedFields: 1,
		blockedApps: [],
	});

	const rows = await changeRows();
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		app_id: id,
		batch_id: `hidden-value-both-sources-v1:${id}:${baseSeq}`,
		actor_id: "system:hidden-value-both-sources",
		kind: "blueprint-migration",
		mutations: [
			{
				kind: "updateField",
				uuid: BOTH,
				targetKind: "hidden",
				patch: { default_value: null },
			},
		],
	});
	expect(Number(rows[0]?.seq)).toBe(baseSeq + 1);
	expect(Number((await h.readAppRow(id))?.mutation_seq)).toBe(baseSeq + 1);

	const after = (await loadSchemaAdmittedAppForInspection(id))?.blueprint;
	expect(after?.fields[BOTH]).toHaveProperty("calculate");
	expect(after?.fields[BOTH]).not.toHaveProperty("default_value");
	expect(after?.fields[CALC_ONLY]).toHaveProperty("calculate");

	// A rerun finds nothing to clear and writes nothing.
	expect(await runHiddenValueBothSourcesRepair([id])).toEqual({
		scannedApps: 1,
		repairedApps: 0,
		clearedFields: 0,
		blockedApps: [],
	});
	expect(await changeRows()).toHaveLength(1);
});

it("reports an app the gate refuses for an unrelated finding and still repairs the next app", async () => {
	const invalid = fixture();
	const text = Object.values(invalid.fields).find(
		(candidate) => candidate.kind === "text",
	);
	if (text === undefined) throw new Error("Missing text field");
	text.required = opaqueXPathExpression("here()");
	const blocked = await h.seedAppWithBlueprint(invalid, { id: "blocked" });
	const good = await h.seedAppWithBlueprint(fixture(), { id: "good" });
	const before = (await loadSchemaAdmittedAppForInspection(blocked))?.blueprint;

	const report = await runHiddenValueBothSourcesRepair([blocked, good]);
	expect(report).toMatchObject({
		scannedApps: 2,
		repairedApps: 1,
		clearedFields: 1,
		blockedApps: [{ appId: blocked, reason: expect.stringContaining("here") }],
	});
	expect((await changeRows()).map((row) => row.app_id)).toEqual([good]);
	expect(
		(await loadSchemaAdmittedAppForInspection(blocked))?.blueprint,
	).toEqual(before);
});

it("includes and repairs a soft-deleted app", async () => {
	const deleted = await h.seedAppWithBlueprint(fixture(), { id: "deleted" });
	const live = await h.seedAppWithBlueprint(fixture(), { id: "live" });
	await h
		.db()
		.updateTable("apps")
		.set({ deleted_at: new Date(), recoverable_until: new Date() })
		.where("id", "=", deleted)
		.execute();

	expect(await listHiddenValueBothSourcesCandidateAppIds()).toEqual(
		expect.arrayContaining([deleted, live]),
	);
	const report = await runHiddenValueBothSourcesRepair([deleted]);
	expect(report).toMatchObject({ repairedApps: 1, blockedApps: [] });
	expect((await changeRows()).map((row) => row.app_id)).toEqual([deleted]);
	const after = (await loadSchemaAdmittedAppForInspection(deleted))?.blueprint;
	expect(after?.fields[BOTH]).not.toHaveProperty("default_value");
});

it("fails on an unreadable snapshot before recording misleading per-app results", async () => {
	const id = await h.seedAppWithBlueprint(fixture());
	await h
		.db()
		.updateTable("blueprint_entities")
		.set({ data: JSON.stringify({ kind: "not-a-field" }) })
		.where("app_id", "=", id)
		.where("kind", "=", "field")
		.execute();
	await expect(runHiddenValueBothSourcesRepair([id])).rejects.toThrow();
	expect(await changeRows()).toEqual([]);
});
