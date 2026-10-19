// An entry whose form logic reads a data table waits for a lookup snapshot
// that covers the table, because printing the read needs the table's naming.
// A same-entry rebuild that has to wait (an edit added the read mid-entry)
// resumes that entry once the covering snapshot arrives: its key, so its
// minted ids and staged captures, and the answers typed so far.

import { afterEach, describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	wireRow,
	wireTable,
} from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { proseText } from "@/lib/domain";
import { eq, literal, tableColumn, tableLookup } from "@/lib/domain/expression";
import { createInProcessXPathWorkerFactory } from "../../xpath/inProcessWorkerClient";
import { XPathRuntime } from "../../xpath/workerClient";
import { EngineController } from "../engineController";
import { previewLookupData } from "../lookupEvaluation";
import { applyControllerEdit } from "./fixtures/controllerDoc";

const FORM = testUuid("lookup-wait-form");
const NAME = testUuid("lookup-wait-name");
const REGION = testUuid("lookup-wait-region");

const table = wireTable("wait_regions", [
	{ name: "value", type: "text" },
	{ name: "label", type: "text" },
]);
const [value, label] = table.columns;

const covering = (revision: string) =>
	previewLookupData({
		projectRevision: revision,
		definitions: [table],
		rowsByTable: new Map([
			[table.id, [wireRow(table, "n", { value: "north", label: "Northland" })]],
		]),
	});
const withoutTable = previewLookupData({
	projectRevision: "2",
	definitions: [],
	rowsByTable: new Map(),
});

const controllers: EngineController[] = [];
afterEach(async () => {
	for (const ctrl of controllers.splice(0)) {
		ctrl.dispose();
		await ctrl.awaitSettled();
	}
});

function controller(async: boolean): EngineController {
	return controllerWithStore(async).ctrl;
}

function controllerWithStore(async: boolean) {
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
										kind: "text",
										uuid: NAME,
										id: "name",
										label: proseText("Name"),
									}),
									f({
										kind: "hidden",
										uuid: REGION,
										id: "region",
										calculate: tableLookup(
											table.id,
											label.id,
											eq(tableColumn(table.id, value.id), literal("north")),
										),
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
	return { ctrl, store };
}

describe("an entry waiting for its lookup snapshot", () => {
	it("starts once a snapshot covers the table its logic reads", async () => {
		const ctrl = controller(true);
		ctrl.setLookupData(withoutTable);
		await ctrl.activateFormAsync(FORM);
		expect(ctrl.formUuid).toBeUndefined();

		ctrl.setLookupData(covering("3"));
		await ctrl.awaitSettled();
		expect(ctrl.formUuid).toBe(FORM);
		expect(ctrl.store.getState()[REGION]?.value).toBe("Northland");
	});

	it("resumes a waiting rebuild as the same entry, with its answers", async () => {
		const ctrl = controller(true);
		ctrl.setLookupData(covering("1"));
		await ctrl.activateFormAsync(FORM);
		await ctrl.onValueChangeAsync(NAME, "Ada");
		const entryKey = ctrl.entryStore.getState().entryKey;
		expect(entryKey).toBeDefined();

		// The rebuild finds the form reading a table the session's snapshot
		// lacks, so it waits with no entry mounted.
		ctrl.setLookupData(withoutTable);
		await ctrl.rebuildActiveFormAsync(FORM);
		expect(ctrl.formUuid).toBeUndefined();

		ctrl.setLookupData(covering("3"));
		await ctrl.awaitSettled();
		expect(ctrl.formUuid).toBe(FORM);
		expect(ctrl.entryStore.getState().entryKey).toBe(entryKey);
		expect(ctrl.store.getState()[NAME]?.value).toBe("Ada");
		expect(ctrl.store.getState()[REGION]?.value).toBe("Northland");
	});

	it("resumes the same entry on the synchronous path too", async () => {
		const ctrl = controller(false);
		ctrl.setLookupData(covering("1"));
		ctrl.activateForm(FORM);
		ctrl.onValueChange(NAME, "Ada");
		const entryKey = ctrl.entryStore.getState().entryKey;

		ctrl.setLookupData(withoutTable);
		ctrl.rebuildActiveForm(FORM);
		expect(ctrl.formUuid).toBeUndefined();

		ctrl.setLookupData(covering("3"));
		expect(ctrl.entryStore.getState().entryKey).toBe(entryKey);
		expect(ctrl.store.getState()[NAME]?.value).toBe("Ada");
	});

	it("starts a fresh entry when the worker opens the form again while it waits", async () => {
		const ctrl = controller(true);
		ctrl.setLookupData(covering("1"));
		await ctrl.activateFormAsync(FORM);
		await ctrl.onValueChangeAsync(NAME, "Ada");
		const entryKey = ctrl.entryStore.getState().entryKey;

		ctrl.setLookupData(withoutTable);
		await ctrl.rebuildActiveFormAsync(FORM);
		await ctrl.activateFormAsync(FORM);

		ctrl.setLookupData(covering("3"));
		await ctrl.awaitSettled();
		expect(ctrl.formUuid).toBe(FORM);
		expect(ctrl.entryStore.getState().entryKey).not.toBe(entryKey);
		expect(ctrl.store.getState()[NAME]?.value).toBe("");
	});

	it("shows a failed lookup load, and opens the form when a retry covers it", async () => {
		const ctrl = controller(true);
		await ctrl.activateFormAsync(FORM);
		expect(ctrl.entryStore.getState().lookupWait).toEqual({
			formUuid: FORM,
			status: "loading",
		});

		ctrl.setLookupLoadFailed(true);
		expect(ctrl.entryStore.getState().lookupWait).toEqual({
			formUuid: FORM,
			status: "error",
		});

		ctrl.setLookupLoadFailed(false);
		ctrl.setLookupData(covering("3"), [table.id]);
		await ctrl.awaitSettled();
		expect(ctrl.formUuid).toBe(FORM);
		expect(ctrl.entryStore.getState().lookupWait).toBeUndefined();
	});

	it("calls a table missing once a read for the form's tables still lacks it", async () => {
		const ctrl = controller(true);
		// Read for other tables: a read for this one is still coming.
		ctrl.setLookupData(withoutTable, []);
		await ctrl.activateFormAsync(FORM);
		expect(ctrl.entryStore.getState().lookupWait?.status).toBe("loading");

		ctrl.setLookupData(withoutTable, [table.id]);
		expect(ctrl.entryStore.getState().lookupWait).toEqual({
			formUuid: FORM,
			status: "unavailable",
		});
	});

	it("opens the form when an edit removes the read it waits on", async () => {
		const { ctrl, store } = controllerWithStore(true);
		ctrl.setLookupData(withoutTable, [table.id]);
		await ctrl.activateFormAsync(FORM);
		expect(ctrl.formUuid).toBeUndefined();

		applyControllerEdit(store, [{ kind: "removeField", uuid: REGION }]);
		await ctrl.awaitSettled();
		expect(ctrl.formUuid).toBe(FORM);
		expect(ctrl.entryStore.getState().lookupWait).toBeUndefined();
	});

	it("resumes a waiting rebuild with its answers when an edit removes the read", async () => {
		const { ctrl, store } = controllerWithStore(true);
		ctrl.setLookupData(covering("1"));
		await ctrl.activateFormAsync(FORM);
		await ctrl.onValueChangeAsync(NAME, "Ada");
		const entryKey = ctrl.entryStore.getState().entryKey;

		ctrl.setLookupData(withoutTable);
		await ctrl.rebuildActiveFormAsync(FORM);
		expect(ctrl.formUuid).toBeUndefined();

		applyControllerEdit(store, [{ kind: "removeField", uuid: REGION }]);
		await ctrl.awaitSettled();
		expect(ctrl.formUuid).toBe(FORM);
		expect(ctrl.entryStore.getState().entryKey).toBe(entryKey);
		expect(ctrl.store.getState()[NAME]?.value).toBe("Ada");
	});
});
