/**
 * Contract: the Builder's column edits keep the case list's faster loading in step with the
 * column choices it shows. A column's first load behavior turns it on in the same save, and
 * clearing or removing the last one turns it off, while an edit that gives or takes no behavior
 * leaves a setting held with no column's choice (an app brought in from CommCare HQ) as it is.
 * The plausible failure: removing the column leaves faster loading on with no control showing
 * it, and a publish then asks the project space for a setting the app does not use.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	columnSnapshotMutations,
	fasterLoadingFollowsColumn,
} from "@/lib/doc/caseListColumnMutations";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	type CaseListConfig,
	type Column,
	calculatedColumn,
	plainColumn,
	type Uuid,
} from "@/lib/domain";
import { prop, term } from "@/lib/domain/expression";

const NAME = "00000000-0000-4000-8000-0000000fa001" as Uuid;
const VISITS = "00000000-0000-4000-8000-0000000fa002" as Uuid;

function app(behavior?: "cache"): BlueprintDoc {
	const visits = calculatedColumn(
		VISITS,
		"Visits",
		term(prop("household", "case_name")),
	);
	return buildDoc({
		caseTypes: [{ name: "household", properties: [] }],
		modules: [
			{
				name: "Households",
				caseType: "household",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								caseWrite: { caseType: "household", property: "case_name" },
							}),
						],
					},
				],
				caseListConfig: {
					columns: [
						plainColumn(NAME, "case_name", "Name"),
						behavior === undefined
							? visits
							: { ...visits, loadBehavior: behavior },
					],
					searchInputs: [],
					...(behavior !== undefined && { optimizations: true }),
				},
			},
		],
	});
}

const moduleOf = (doc: BlueprintDoc) => doc.moduleOrder[0] as Uuid;
const listOf = (doc: BlueprintDoc): CaseListConfig => {
	const config = doc.modules[moduleOf(doc)]?.caseListConfig;
	if (config === undefined) throw new Error("The menu has no case list.");
	return config;
};
const columnOf = (doc: BlueprintDoc, uuid: Uuid): Column => {
	const column = listOf(doc).columns.find((one) => one.uuid === uuid);
	if (column === undefined) throw new Error("The column is missing.");
	return column;
};

/** The Builder's batch for replacing (or, with `next` undefined, removing) one column. */
function commit(doc: BlueprintDoc, current: Column, next: Column | undefined) {
	const moduleUuid = moduleOf(doc);
	const loading = fasterLoadingFollowsColumn(
		moduleUuid,
		listOf(doc),
		current,
		next,
	);
	const change: Mutation[] =
		next === undefined
			? [{ kind: "removeColumn", moduleUuid, uuid: current.uuid }]
			: columnSnapshotMutations(moduleUuid, current, next);
	const verdict = mutationCommitVerdict(
		doc,
		[...loading.before, ...change, ...loading.after],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));
	return verdict.nextDoc;
}

describe("a case list's faster loading under the Builder's column edits", () => {
	it("turns off as the last column that chooses a load behavior is removed", () => {
		const doc = app("cache");
		const next = commit(doc, columnOf(doc, VISITS), undefined);
		expect(listOf(next).optimizations).toBeUndefined();
	});

	it("turns on with a column's first choice and off as the choice is cleared", () => {
		const doc = app();
		const visits = columnOf(doc, VISITS);
		const on = commit(doc, visits, {
			...visits,
			loadBehavior: "defer",
		} as Column);
		expect(listOf(on).optimizations).toBe(true);
		const off = commit(on, columnOf(on, VISITS), visits);
		expect(listOf(off).optimizations).toBeUndefined();
	});

	it("keeps a setting no column's choice holds through an unrelated edit or removal", () => {
		const doc = produce(app(), (draft) => {
			const config = draft.modules[moduleOf(draft)]?.caseListConfig;
			if (config) config.optimizations = true;
		});
		const name = columnOf(doc, NAME);
		const edited = commit(doc, name, {
			...name,
			header: "Household",
		} as Column);
		expect(listOf(edited).optimizations).toBe(true);
		const removed = commit(edited, columnOf(edited, VISITS), undefined);
		expect(listOf(removed).optimizations).toBe(true);
	});
});
