import { expect } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	type FieldSpec,
	type FormSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type CaseType,
	type Column,
	plainColumn,
} from "@/lib/domain";
import { runValidation } from "../../../runner";

/** Reachable starting document. Candidates are then changed immutably so the
 * production effective-property caches cannot accidentally see stale state. */
export function admittedCaseListDoc(
	args: {
		fields?: FieldSpec[];
		additionalForms?: FormSpec[];
		caseTypes?: CaseType[];
		columns?: Column[];
	} = {},
): BlueprintDoc {
	const doc = buildDoc({
		appName: "Case list rules",
		caseTypes: args.caseTypes ?? [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: args.columns ?? [
						plainColumn(testUuid("rule-anchor"), "case_name", "Name"),
					],
					searchInputs: [],
				},
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							...(args.fields ?? []),
						],
					},
					...(args.additionalForms ?? []),
				],
			},
		],
	});
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	return doc;
}
export function withColumns(
	doc: BlueprintDoc,
	columns: Column[],
	order = columns.map((column) => column.uuid),
): BlueprintDoc {
	const anchor = plainColumn(testUuid("rule-anchor"), "case_name", "Name");
	columns = [...columns, anchor];
	order = [...order, anchor.uuid];
	const id = doc.moduleOrder[0];
	const result = {
		...doc,
		modules: {
			...doc.modules,
			[id]: {
				...doc.modules[id],
				caseListConfig: {
					...doc.modules[id].caseListConfig,
					columns,
					listColumnOrder: order,
					detailColumnOrder: [...order],
					searchInputs: doc.modules[id].caseListConfig?.searchInputs ?? [],
				},
			},
		},
	};
	blueprintDocSchema.parse(toPersistableDoc(result));
	return result;
}
export const findings = (doc: BlueprintDoc) =>
	runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
export function withSearchInputs(
	doc: BlueprintDoc,
	searchInputs: import("@/lib/domain").SearchInputDef[],
): BlueprintDoc {
	const id = doc.moduleOrder[0];
	const module = doc.modules[id];
	if (!module.caseListConfig) throw new Error("Missing admitted config");
	const result = {
		...doc,
		modules: {
			...doc.modules,
			[id]: {
				...module,
				caseListConfig: { ...module.caseListConfig, searchInputs },
			},
		},
	};
	blueprintDocSchema.parse(toPersistableDoc(result));
	return result;
}
