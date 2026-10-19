// A form that reads data the device holds none of is refused, as Core
// refuses it: a choice list over a table with no rows does not open, and a
// link that reads an empty table stops the entry once the form is saved. The
// controller publishes a refusal on its entry state, reports nothing, and
// opens the form again when rows arrive.

import { afterEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	wireRow,
	wireTable,
} from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { proseText } from "@/lib/domain";
import { createInProcessXPathWorkerFactory } from "../../xpath/inProcessWorkerClient";
import { XPathRuntime } from "../../xpath/workerClient";
import { snapshotXPathWorkerInstance } from "../../xpath/workerProjection";
import { PreviewDataRefusal } from "../dataRefusal";
import { EngineController } from "../engineController";
import { evaluateFormSnapshot } from "../evaluateFormSnapshot";
import { FormEvaluationInputError } from "../formEvaluationTypes";
import { previewAsMe } from "../identity";
import { previewLookupData } from "../lookupEvaluation";
import { lookupXPathInstances } from "../xpathInstances";

const FORM = testUuid("data-refusal-form");
const DISTRICT = testUuid("data-refusal-district");

const table = wireTable("refusal_districts", [
	{ name: "code", type: "text" },
	{ name: "name", type: "text" },
]);
const [code, name] = table.columns;

const withRows = (revision: string, rows: number) =>
	previewLookupData({
		projectRevision: revision,
		definitions: [table],
		rowsByTable: new Map([
			[
				table.id,
				rows === 0 ? [] : [wireRow(table, "n", { code: "n", name: "North" })],
			],
		]),
	});

const controllers: EngineController[] = [];
afterEach(async () => {
	for (const ctrl of controllers.splice(0)) {
		ctrl.dispose();
		await ctrl.awaitSettled();
	}
});

function controller(async: boolean) {
	if (code === undefined || name === undefined)
		throw new Error("The table's columns are missing.");
	const store = createBlueprintDocStore();
	store.getState().load(
		toPersistableDoc(
			buildDoc({
				modules: [
					{
						name: "Visits",
						forms: [
							{
								uuid: FORM,
								name: "Visit",
								type: "survey",
								fields: [
									f({
										kind: "single_select",
										uuid: DISTRICT,
										id: "district",
										label: proseText("District"),
										optionsSource: {
											kind: "lookup",
											tableId: table.id,
											valueColumnId: code.id,
											labelColumnId: name.id,
										},
									}),
								],
							},
						],
					},
				],
			}),
		),
	);
	store.getState().startTracking();
	const ctrl = new EngineController(
		async
			? new XPathRuntime({ workerFactory: createInProcessXPathWorkerFactory() })
			: undefined,
	);
	controllers.push(ctrl);
	ctrl.setDocStore(store);
	const report = vi.fn();
	ctrl.setFaultReporter(report);
	return { ctrl, report };
}

describe("a choice list over a table with no rows", () => {
	for (const async of [false, true]) {
		it(`refuses the form without reporting it, and opens it once the table has rows (${async ? "worker" : "synchronous"} path)`, async () => {
			const { ctrl, report } = controller(async);
			ctrl.setLookupData(withRows("1", 0), [table.id]);
			if (async) await ctrl.activateFormAsync(FORM);
			else ctrl.activateForm(FORM);
			await ctrl.awaitSettled();

			expect(ctrl.entryStore.getState()).toMatchObject({
				formUuid: undefined,
				fault: undefined,
				refusal: {
					kind: "data",
					formUuid: FORM,
					stage: "form",
					reason: {
						kind: "empty-choice-table",
						tableId: table.id,
						fieldUuid: DISTRICT,
					},
				},
			});
			expect(report).not.toHaveBeenCalled();

			// The same snapshot again changes nothing: the table is still empty.
			ctrl.setLookupData(ctrl.previewLookupDataSnapshot, [table.id]);
			expect(ctrl.entryStore.getState().refusal?.kind).toBe("data");

			ctrl.setLookupData(withRows("2", 1), [table.id]);
			await ctrl.awaitSettled();
			expect(ctrl.entryStore.getState().refusal).toBeUndefined();
			expect(ctrl.formUuid).toBe(FORM);
			expect(report).not.toHaveBeenCalled();
		});
	}
});

describe("a link that reads a table with no rows", () => {
	it("stops the entry at its links without reporting it", async () => {
		const { ctrl, report } = controller(true);
		ctrl.setLookupData(withRows("1", 1), [table.id]);
		await ctrl.activateFormAsync(FORM);
		const entryKey = ctrl.entryStore.getState().entryKey;
		if (entryKey === undefined) throw new Error("The form did not open.");

		const empty = withRows("2", 0);
		const naming = empty.naming.tables[0];
		if (naming === undefined) throw new Error("The table has no naming.");
		const instance = lookupXPathInstances(empty, {
			includeFixtureAliases: true,
		}).get(naming.fixtureId);
		if (instance === undefined) throw new Error("The table has no instance.");

		await expect(
			ctrl.evaluateFormLinkXPaths(entryKey, (evaluate) =>
				evaluate(
					`instance('${naming.fixtureId}')/${naming.listElementName}/${naming.rowElementName}[code = 'n']/name = 'North'`,
					{
						secondary: [snapshotXPathWorkerInstance(instance)],
						contextPath: "",
					},
				),
			),
		).rejects.toBeInstanceOf(PreviewDataRefusal);
		expect(ctrl.entryStore.getState()).toMatchObject({
			fault: undefined,
			refusal: {
				kind: "data",
				formUuid: FORM,
				stage: "links",
				reason: { kind: "empty-instance", instanceId: naming.fixtureId },
			},
		});
		expect(report).not.toHaveBeenCalled();
	});
});

describe("an evaluation of a form whose choice table has no rows", () => {
	it("reports what a phone does, naming the question and the table", async () => {
		if (code === undefined || name === undefined)
			throw new Error("The table's columns are missing.");
		const doc = buildDoc({
			modules: [
				{
					name: "Visits",
					forms: [
						{
							uuid: FORM,
							name: "Visit",
							type: "survey",
							fields: [
								f({
									kind: "single_select",
									uuid: DISTRICT,
									id: "district",
									label: proseText("District"),
									optionsSource: {
										kind: "lookup",
										tableId: table.id,
										valueColumnId: code.id,
										labelColumnId: name.id,
									},
								}),
							],
						},
					],
				},
			],
		});
		const identity = previewAsMe({ id: "member" }, doc);
		if (!identity) throw new Error("No preview identity.");
		const evaluation = evaluateFormSnapshot(
			doc,
			{ formUuid: FORM, answers: [] },
			{
				identity,
				cases: { rows: [], indices: [] },
				lookup: {
					projectRevision: "1",
					definitions: [table],
					rowsByTable: new Map([[table.id, []]]),
				},
			},
		);
		await expect(evaluation).rejects.toBeInstanceOf(FormEvaluationInputError);
		await expect(evaluation).rejects.toMatchObject({
			message: `This form stops here on a phone. “District” gets its choices from “${table.name}”, which has no rows, so a phone won't open it. You can add rows to “${table.name}” in Project data.`,
		});
	});
});
