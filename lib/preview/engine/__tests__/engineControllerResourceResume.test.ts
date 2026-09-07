import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { simpleSearchInputDef } from "@/lib/domain";
import { assertAdmittedPreviewDoc } from "../../__tests__/fixtures/admittedDoc";
import { createInProcessXPathWorkerFactory } from "../../xpath/inProcessWorkerClient";
import { XPathRuntime } from "../../xpath/workerClient";
import { EngineController } from "../engineController";

const FORM = testUuid("resume-no-matches-form");
const NAME = testUuid("resume-no-matches-name");
const SEARCH = testUuid("resume-no-matches-search");

function storeForSearchRegistration() {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.searchInputs = [
		simpleSearchInputDef(
			SEARCH,
			"patient_name",
			"Patient name",
			"text",
			"case_name",
		),
	];
	const doc = buildDoc({
		appName: "Search registration",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: config,
				caseSearchConfig: { searchFirst: true },
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "notes", label: "Notes" })],
					},
					{
						uuid: FORM,
						name: "Register",
						type: "registration",
						entry: { kind: "search-no-matches" },
						fields: [
							f({
								uuid: NAME,
								kind: "text",
								id: "name",
								label: "Name",
								caseWrite: { caseType: "patient", property: "case_name" },
								default_value: {
									parts: [
										{ kind: "search-answer-ref", searchInputUuid: SEARCH },
									],
								},
							}),
						],
					},
				],
			},
		],
	});
	assertAdmittedPreviewDoc(doc);
	const store = createBlueprintDocStore();
	store.getState().load(doc);
	return store;
}

describe("search answers across device-data resource suspension", () => {
	it.each([false, true])(
		"keeps the admitted search answers when required data arrives (worker=%s)",
		async (worker) => {
			const ctrl = new EngineController(
				worker
					? new XPathRuntime({
							workerFactory: createInProcessXPathWorkerFactory(),
						})
					: undefined,
			);
			try {
				ctrl.setDocStore(storeForSearchRegistration());
				ctrl.setCaseDatabaseState({ required: true, status: "loading" });
				await ctrl.activateFormAsync(
					FORM,
					undefined,
					undefined,
					new Map([["patient_name", "Amina"]]),
				);
				expect(ctrl.entryStore.getState().caseDatabaseWait).toEqual({
					formUuid: FORM,
					status: "loading",
				});
				ctrl.setCaseDatabaseState({
					required: true,
					status: "ready",
					snapshot: { rows: [], indices: [] },
				});
				await ctrl.awaitSettled();
				expect(ctrl.entryStore.getState().fault).toBeUndefined();
				expect(ctrl.store.getState()[NAME]?.value).toBe("Amina");
				ctrl.setCaseDatabaseState({ required: true, status: "loading" });
				expect(ctrl.formUuid).toBeUndefined();
				ctrl.setCaseDatabaseState({
					required: true,
					status: "ready",
					snapshot: { rows: [], indices: [] },
				});
				await ctrl.awaitSettled();
				expect(ctrl.store.getState()[NAME]?.value).toBe("Amina");
			} finally {
				ctrl.dispose();
				await ctrl.awaitSettled();
			}
		},
	);
});
