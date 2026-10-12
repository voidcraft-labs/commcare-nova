import { describe, expect, it } from "vitest";
import {
	CLINIC_A,
	CLINIC_B,
	caseChoiceDoc,
	caseChoiceInput,
	caseChoiceSnapshot,
	choiceUuid,
	memberId,
} from "@/lib/__tests__/caseChoiceFixture";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	wireRow,
	wireTable,
} from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import {
	eq,
	formField,
	literal,
	prop,
	tableColumn,
	tableLookup,
} from "@/lib/domain/predicate";
import { assertAdmittedPreviewDoc } from "../../__tests__/fixtures/admittedDoc";
import { createInProcessXPathWorkerFactory } from "../../xpath/inProcessWorkerClient";
import { XPathRuntime } from "../../xpath/workerClient";
import { deserializeXPathWorkerValue } from "../../xpath/workerProjection";
import { FormEngine, type FormEngineAsyncEvaluator } from "../formEngine";
import { previewLookupData } from "../lookupEvaluation";
import { caseDatabaseRequirements } from "../useCaseDatabaseSnapshot";

function workerFor(engine: FormEngine) {
	const runtime = new XPathRuntime({
		workerFactory: createInProcessXPathWorkerFactory(),
	});
	const world = engine.createWorkerWorld("case-choice-test");
	const evaluateAsync = (async (
		source,
		path,
		resultMode = "scalar",
		stateOverrides,
	) => {
		const result = await runtime.request({
			entryKey: "case-choice-entry",
			revision: 0,
			profile: "form",
			source,
			resultMode,
			instances: engine.workerInstances(source, path, world, stateOverrides),
		});
		if (!result.ok) throw new Error(`${result.error.code}`);
		return result.nodesetValues === undefined
			? deserializeXPathWorkerValue(result.value)
			: { kind: "nodeset-values", values: result.nodesetValues };
	}) as FormEngineAsyncEvaluator;
	return { runtime, evaluateAsync };
}

describe("case choices in the captured device world", () => {
	it.each([false, true])(
		"keeps a stable 30-member roster across back navigation and collects final membership (worker=%s)",
		async (stagedAsync) => {
			const doc = assertAdmittedPreviewDoc(caseChoiceDoc());
			const selected = new Map([["clinic", new Map([["case_id", CLINIC_A]])]]);
			const engine = new FormEngine(
				caseChoiceInput(doc, choiceUuid("attendance")),
				"clinic",
				selected,
				undefined,
				undefined,
				caseChoiceSnapshot(),
				{ stagedAsync },
			);
			const { runtime, evaluateAsync } = workerFor(engine);
			try {
				if (stagedAsync) await engine.initializeAsync(evaluateAsync);
				const answer = async (value: string) => {
					if (stagedAsync)
						await engine.setValueAsync(
							"/data/entry/attendees",
							value,
							evaluateAsync,
						);
					else engine.setValue("/data/entry/attendees", value);
				};
				const enter = async (section: string) => {
					if (stagedAsync)
						await engine.enterSectionAsync(choiceUuid(section), evaluateAsync);
					else engine.enterSection(choiceUuid(section));
				};
				expect(engine.getState("/data/entry/attendees").choices).toHaveLength(
					30,
				);
				expect(engine.getRepeatCount("/data/entry/roster")).toBe(30);
				await answer(`${memberId(0)} ${memberId(1)}`);
				await enter("review");
				await enter("entry");
				await answer(`${memberId(1)} ${memberId(29)}`);
				await enter("review");
				expect(engine.getRepeatCount("/data/entry/roster")).toBe(30);
				const submission = engine.computeSubmissionMutation({
					caseIds: [CLINIC_A],
					entryKey: choiceUuid("entry-key"),
				});
				const rows = submission.operationAnswers?.repeats[0].iterations.map(
					(answers) => new Map(answers.map((a) => [a.fieldUuid, a.value])),
				);
				expect(rows).toHaveLength(30);
				expect(
					rows
						?.filter((row) => row.get(choiceUuid("attended")) === "yes")
						.map((row) => row.get(choiceUuid("member-id"))),
				).toEqual([memberId(1), memberId(29)]);
			} finally {
				runtime.dispose();
			}
		},
	);
	it.each([false, true])(
		"recomputes membership, retains exact IDs, and cascades removed selections (worker=%s)",
		async (stagedAsync) => {
			const doc = assertAdmittedPreviewDoc(caseChoiceDoc());
			const engine = new FormEngine(
				caseChoiceInput(doc),
				undefined,
				undefined,
				undefined,
				undefined,
				caseChoiceSnapshot(),
				{ stagedAsync },
			);
			const { runtime, evaluateAsync } = workerFor(engine);
			try {
				if (stagedAsync) await engine.initializeAsync(evaluateAsync);
				const answer = async (path: string, value: string) => {
					if (stagedAsync)
						await engine.setValueAsync(path, value, evaluateAsync);
					else engine.setValue(path, value);
				};
				expect(
					engine.getState("/data/clinic").choices?.map((c) => c.value),
				).toEqual([CLINIC_A, CLINIC_B]);
				expect(engine.getState("/data/members").choices).toEqual([]);
				await answer("/data/clinic", CLINIC_A);
				expect(engine.getState("/data/members").choices).toHaveLength(30);
				expect(engine.getState("/data/members").choices?.slice(0, 2)).toEqual([
					{ key: memberId(0), value: memberId(0), label: "Alex" },
					{ key: memberId(1), value: memberId(1), label: "Alex" },
				]);
				await answer("/data/members", `${memberId(0)} ${memberId(1)}`);
				expect(engine.getState("/data/selected").value).toBe(
					`${memberId(0)} ${memberId(1)}`,
				);
				await answer("/data/clinic", CLINIC_B);
				expect(
					engine.getState("/data/members").choices?.map((c) => c.value),
				).toEqual([memberId(30)]);
				expect(engine.getState("/data/members").value).toBe("");
				expect(engine.getState("/data/selected").value).toBe("");
			} finally {
				runtime.dispose();
			}
		},
	);

	it.each([false, true])(
		"scopes earlier-answer choice filters to each repeat row (worker=%s)",
		async (stagedAsync) => {
			const doc = assertAdmittedPreviewDoc(
				buildDoc({
					caseTypes: caseChoiceDoc().caseTypes,
					modules: [
						{
							name: "Directory",
							forms: [
								{
									uuid: choiceUuid("directory"),
									name: "Directory",
									type: "survey",
									fields: [
										f({
											kind: "repeat",
											id: "visits",
											label: "Visits",
											children: [
												f({
													kind: "text",
													uuid: choiceUuid("region"),
													id: "region",
													label: "Region",
												}),
												f({
													kind: "single_select",
													id: "clinic",
													label: "Clinic",
													optionsSource: {
														kind: "cases",
														caseType: "clinic",
														labelProperty: "case_name",
														filter: eq(
															prop("clinic", "region"),
															formField(choiceUuid("region")),
														),
													},
												}),
											],
										}),
									],
								},
							],
						},
					],
				}),
			);
			const engine = new FormEngine(
				caseChoiceInput(doc),
				undefined,
				undefined,
				undefined,
				undefined,
				{
					...caseChoiceSnapshot(),
					rows: caseChoiceSnapshot().rows.map((row) => ({
						...row,
						properties: {
							...row.properties,
							region: row.case_id === CLINIC_A ? "east" : "west",
						},
					})),
				},
				{ stagedAsync },
			);
			const { runtime, evaluateAsync } = workerFor(engine);
			try {
				if (stagedAsync) await engine.initializeAsync(evaluateAsync);
				const answer = async (path: string, value: string) => {
					if (stagedAsync)
						await engine.setValueAsync(path, value, evaluateAsync);
					else engine.setValue(path, value);
				};
				for (let i = engine.getRepeatCount("/data/visits"); i < 2; i++) {
					if (stagedAsync)
						await engine.addRepeatAsync("/data/visits", evaluateAsync);
					else engine.addRepeat("/data/visits");
				}
				await answer("/data/visits[0]/region", "east");
				await answer("/data/visits[1]/region", "west");
				expect(
					engine
						.getState("/data/visits[0]/clinic")
						.choices?.map((c) => c.value),
				).toEqual([CLINIC_A]);
				expect(
					engine
						.getState("/data/visits[1]/clinic")
						.choices?.map((c) => c.value),
				).toEqual([CLINIC_B]);
				await answer("/data/visits[0]/clinic", CLINIC_A);
				await answer("/data/visits[1]/clinic", CLINIC_B);
				await answer("/data/visits[0]/region", "west");
				expect(engine.getState("/data/visits[0]/clinic").value).toBe("");
				expect(engine.getState("/data/visits[1]/clinic").value).toBe(CLINIC_B);
			} finally {
				runtime.dispose();
			}
		},
	);

	it.each([false, true])(
		"waits for nested lookup data and evaluates it in the captured worker world (worker=%s)",
		async (stagedAsync) => {
			const table = wireTable("clinics", [{ name: "id", type: "text" }]);
			const doc = caseChoiceDoc();
			const field = doc.fields[choiceUuid("clinic")];
			if (
				field.kind !== "single_select" ||
				field.optionsSource.kind !== "cases"
			)
				throw new Error("Expected case choices");
			field.optionsSource.filter = eq(
				prop("clinic", "case_id"),
				tableLookup(
					table.id,
					table.columns[0].id,
					eq(tableColumn(table.id, table.columns[0].id), literal(CLINIC_A)),
				),
			);
			const data = previewLookupData({
				projectRevision: "1",
				definitions: [table],
				rowsByTable: new Map([
					[table.id, [wireRow(table, "east", { id: CLINIC_A })]],
				]),
			});
			const loading = new FormEngine(
				caseChoiceInput(doc),
				undefined,
				undefined,
				undefined,
				undefined,
				caseChoiceSnapshot(),
			);
			expect(loading.usesLookupData()).toBe(true);
			expect(loading.lookupDataCoversForm()).toBe(false);
			expect(loading.getState("/data/clinic").choices).toBeUndefined();
			const engine = new FormEngine(
				caseChoiceInput(doc),
				undefined,
				undefined,
				undefined,
				data,
				caseChoiceSnapshot(),
				{ stagedAsync },
			);
			const { runtime, evaluateAsync } = workerFor(engine);
			try {
				if (stagedAsync) await engine.initializeAsync(evaluateAsync);
				expect(engine.lookupDataCoversForm()).toBe(true);
				expect(
					engine.getState("/data/clinic").choices?.map((c) => c.value),
				).toEqual([CLINIC_A]);
			} finally {
				runtime.dispose();
			}
		},
	);

	it("requires a snapshot for an unfiltered source and distinguishes loading from no cases", () => {
		const doc = caseChoiceDoc();
		expect(caseDatabaseRequirements(doc).required).toBe(true);
		const loading = new FormEngine(caseChoiceInput(doc));
		expect(loading.getState("/data/clinic").choices).toBeUndefined();
		const empty = new FormEngine(
			caseChoiceInput(doc),
			undefined,
			undefined,
			undefined,
			undefined,
			{ rows: [], indices: [] },
		);
		expect(empty.getState("/data/clinic").choices).toEqual([]);
		const snapshot = caseChoiceSnapshot();
		const one = new FormEngine(
			caseChoiceInput(doc),
			undefined,
			undefined,
			undefined,
			undefined,
			{ ...snapshot, rows: [{ ...snapshot.rows[0], status: "closed" }] },
		);
		expect(one.getState("/data/clinic").choices).toEqual([
			{ key: CLINIC_A, value: CLINIC_A, label: "East clinic" },
		]);
	});
});
