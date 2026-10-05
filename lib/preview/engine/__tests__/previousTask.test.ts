import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { projectPreviousTask } from "@/lib/commcare";
import {
	followupNestedDoc,
	nestSecondModule,
	registrationNestedDoc,
} from "@/lib/commcare/__tests__/nestedMenuWireFixture";
import { afterSubmitRoute } from "@/lib/preview/afterSubmitRouting";
import type { CaseRow } from "../caseDataBindingTypes";
import { formNavigation } from "../navigationProjection";
import {
	previousTaskFormSelectors,
	resolvePreviousTask,
	selectionsForModuleTask,
} from "../previousTask";

const MODULE = testUuid("records");
const FORM = testUuid("visit");
function doc(formsFirst: boolean, multiple = false) {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	return buildDoc({
		caseTypes: [{ name: "record", properties: [] }],
		modules: [
			{
				uuid: "records",
				name: "Records",
				caseType: "record",
				caseListConfig: {
					...config,
					...(multiple && {
						selection: { kind: "multiple" as const, maximum: 3 },
					}),
				},
				forms: [
					{
						uuid: "visit",
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note" })],
					},
					...(formsFirst
						? [
								{
									uuid: "register",
									name: "Register",
									type: "registration" as const,
									postSubmit: "previous" as const,
									fields: [
										f({
											kind: "text",
											id: "name",
											caseWrite: { caseType: "record", property: "case_name" },
										}),
									],
								},
							]
						: []),
				],
			},
		],
	});
}
function row(caseId: string, status: "open" | "closed" = "open"): CaseRow {
	return {
		case_id: caseId,
		app_id: "app",
		case_type: "record",
		owner_id: "worker",
		status,
		opened_on: new Date("2026-09-01"),
		modified_on: new Date("2026-10-01"),
		closed_on: status === "closed" ? new Date("2026-10-01") : null,
		case_name: caseId,
		external_id: null,
		parent_case_id: null,
		properties: { note: "Saved" },
	};
}

describe("the native preceding task", () => {
	it("retires a module's leaf selection without discarding its owner-retained parent", () => {
		const blueprint = followupNestedDoc({ parentSelect: true });
		const { root, child } = nestSecondModule(blueprint);
		const parent = { caseType: "gold-fish", cases: [{ caseId: "parent" }] };
		const selections = {
			[root]: parent,
			[child]: { caseType: "guppy", cases: [{ caseId: "child" }] },
		};
		const next = selectionsForModuleTask(blueprint, child, selections);
		expect(next).toEqual({ [root]: parent });
		expect(next[root]).toBe(parent);
		expect(selections[child].cases).toEqual([{ caseId: "child" }]);
	});
	it("reopens the exact forms-first selector and drops even a deep-linked own record", () => {
		const blueprint = doc(true);
		const result = resolvePreviousTask({
			doc: blueprint,
			formUuid: FORM,
			submittedCaseIds: ["a"],
			selections: {
				[MODULE]: { caseType: "record", cases: [{ caseId: "a" }] },
			},
			caseDatabase: { rows: [row("a")], indices: [] },
		});
		expect(result).toMatchObject({
			destination: {
				kind: "record-selection",
				moduleUuid: MODULE,
				formUuid: FORM,
				selectingModuleUuids: [MODULE],
			},
			selections: {},
		});
		expect(formNavigation(blueprint, FORM)?.afterSubmit.fallback).toEqual({
			screen: "record-selection",
			moduleUuid: MODULE,
			formUuid: FORM,
			selectingModuleUuids: [MODULE],
			name: "Visit",
		});
	});
	it.each([false, true])(
		"returns to the case-first menu with exact saved records (multiple %s)",
		(multiple) => {
			const blueprint = doc(false, multiple);
			const ids = multiple ? ["b", "a"] : ["a"];
			const result = resolvePreviousTask({
				doc: blueprint,
				formUuid: FORM,
				submittedCaseIds: ids,
				selections: {
					[testUuid("unrelated")]: {
						caseType: "record",
						cases: [{ caseId: "stale" }],
					},
				},
				caseDatabase: { rows: [row("a", "closed"), row("b")], indices: [] },
			});
			expect(result.destination).toEqual({ kind: "menu", moduleUuid: MODULE });
			expect(Object.keys(result.selections)).toEqual([MODULE]);
			expect(
				result.selections[MODULE].cases.map((choice) => choice.caseId),
			).toEqual(ids);
			expect(
				result.selections[MODULE].cases.find((choice) => choice.caseId === "a")
					?.caseProperties,
			).toMatchObject({ note: "Saved", status: "closed" });
		},
	);
	it.each([false, true])(
		"does not turn computed registration values into selected records (mixed %s)",
		(mixed) => {
			const blueprint = doc(true);
			if (!mixed) blueprint.formOrder[MODULE] = [testUuid("register")];
			const result = resolvePreviousTask({
				doc: blueprint,
				formUuid: testUuid("register"),
				submittedCaseIds: ["created"],
				selections: {},
				caseDatabase: { rows: [row("created")], indices: [] },
			});
			expect(result).toMatchObject({
				destination: { kind: "menu", moduleUuid: MODULE },
				selections: {},
			});
		},
	);
	it("keeps stable target identity through module and form reorder", () => {
		const blueprint = doc(true);
		blueprint.moduleOrder.unshift(testUuid("extra"));
		blueprint.modules[testUuid("extra")] = {
			uuid: testUuid("extra"),
			id: "other",
			name: "Other",
		};
		blueprint.formOrder[MODULE].reverse();
		expect(projectPreviousTask(blueprint, FORM).destination).toEqual({
			kind: "record-selection",
			moduleUuid: MODULE,
			formUuid: FORM,
			selectingModuleUuids: [MODULE],
		});
	});
	it("refuses a retained record missing from the receipt world", () => {
		expect(() =>
			resolvePreviousTask({
				doc: doc(false),
				formUuid: FORM,
				submittedCaseIds: ["missing"],
				selections: {},
				caseDatabase: { rows: [], indices: [] },
			}),
		).toThrow("absent from the saved device state");
	});
	it("keeps an explicit parent selection and computed root prefix without inventing a new child selection", () => {
		// This fixture's raw frame is independently pinned to HQ's child-module
		// previous-frame oracle in nestedMenus.test.ts.
		const blueprint = followupNestedDoc({
			parentSelect: true,
			parentCreatesChild: true,
			childPostSubmitPrevious: true,
			childFilter: false,
		});
		const { root, child, childForm } = nestSecondModule(blueprint);
		if (!childForm) throw new Error("Missing child form");
		const result = resolvePreviousTask({
			doc: blueprint,
			formUuid: childForm,
			submittedCaseIds: ["child"],
			selections: {
				[root]: { caseType: "gold-fish", cases: [{ caseId: "parent" }] },
				[child]: { caseType: "guppy", cases: [{ caseId: "child" }] },
			},
			caseDatabase: {
				rows: [
					{ ...row("parent"), case_type: "gold-fish" },
					{ ...row("child", "closed"), case_type: "guppy" },
				],
				indices: [],
			},
		});
		expect(result.destination).toEqual({
			kind: "record-selection",
			moduleUuid: child,
			formUuid: childForm,
			selectingModuleUuids: [child],
		});
		expect(Object.keys(result.selections)).toEqual([root]);
		expect(
			result.selections[root].cases.map((choice) => choice.caseId),
		).toEqual(["parent"]);
	});
	it("starts a newly chosen form with its actual missing selectors while respecting a defined blank ancestor", () => {
		const blueprint = followupNestedDoc({ parentSelect: true });
		const { root, child, childForm } = nestSecondModule(blueprint);
		if (!childForm) throw new Error("Missing child form");
		expect(previousTaskFormSelectors(blueprint, childForm, {})).toEqual([
			root,
			child,
		]);
		expect(
			previousTaskFormSelectors(blueprint, childForm, {
				[root]: { caseType: "gold-fish", cases: [] },
			}),
		).toEqual([child]);
	});
	it.each([false, true])(
		"returns nested registration to its child menu without a parent selection the entry never loaded (parent %s)",
		(explicitParent) => {
			const blueprint = registrationNestedDoc(true);
			const { root, child, childForm } = nestSecondModule(blueprint);
			if (!childForm) throw new Error("Missing child form");
			if (explicitParent) blueprint.modules[child].parentCaseModuleUuid = root;
			const result = resolvePreviousTask({
				doc: blueprint,
				formUuid: childForm,
				submittedCaseIds: ["created-service"],
				selections: {
					[root]: { caseType: "plan", cases: [{ caseId: "plan" }] },
				},
				caseDatabase: {
					rows: [{ ...row("plan"), case_type: "plan" }],
					indices: [],
				},
			});
			expect(result.destination).toEqual({ kind: "menu", moduleUuid: child });
			expect(Object.keys(result.selections)).toEqual([]);
			// An externally targeted frame prepends the structural parent's
			// selection; choosing this command on its current menu does not.
			expect(previousTaskFormSelectors(blueprint, childForm, {})).toEqual([]);
		},
	);
	it("preserves a defined blank ancestor selection", () => {
		const blueprint = followupNestedDoc({
			parentSelect: true,
			childPostSubmitPrevious: true,
		});
		const { root, childForm } = nestSecondModule(blueprint);
		if (!childForm) throw new Error("Missing child form");
		const result = resolvePreviousTask({
			doc: blueprint,
			formUuid: childForm,
			submittedCaseIds: ["child"],
			selections: { [root]: { caseType: "gold-fish", cases: [] } },
			caseDatabase: { rows: [], indices: [] },
		});
		expect(result.selections).toEqual({
			[root]: { caseType: "gold-fish", cases: [] },
		});
	});
	it("uses the same preceding task for a false link fallback and leaves a true link authoritative", () => {
		const blueprint = doc(true);
		const task = resolvePreviousTask({
			doc: blueprint,
			formUuid: FORM,
			submittedCaseIds: ["a"],
			selections: {},
			caseDatabase: { rows: [row("a")], indices: [] },
		});
		const common = {
			doc: blueprint,
			caseFirstModules: new Set<typeof MODULE>(),
			caseSelections: () => [],
			carriedCase: () => ({ kind: "none" as const }),
		};
		expect(
			afterSubmitRoute({
				...common,
				choice: { kind: "fallback", destination: "previous" },
				previousTask: () => task,
			}),
		).toEqual({ kind: "previous-task", task });
		expect(
			afterSubmitRoute({
				...common,
				choice: {
					kind: "link",
					index: 0,
					link: {
						uuid: testUuid("link"),
						target: { type: "module", moduleUuid: MODULE },
					},
				},
				previousTask: () => {
					throw new Error("must not evaluate fallback");
				},
			}),
		).toMatchObject({ kind: "module", moduleUuid: MODULE });
	});
});
