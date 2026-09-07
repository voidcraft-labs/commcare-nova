import { describe, expect, it } from "vitest";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { searchBlueprint } from "@/lib/doc/searchBlueprint";
import {
	asUuid,
	type BlueprintDoc,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

const MODULE = asUuid("11111111-1111-4111-8111-111111111111");
const FORM = asUuid("22222222-2222-4222-8222-222222222222");
const FIELD = asUuid("33333333-3333-4333-8333-333333333333");
const COLUMN = asUuid("44444444-4444-4444-8444-444444444444");
const INPUT = asUuid("55555555-5555-4555-8555-555555555555");

function identityFixture(): BlueprintDoc {
	const doc: BlueprintDoc = {
		appId: "search-identity",
		appName: "Search identity",
		connectType: null,
		caseTypes: [
			{
				name: "target_case",
				properties: [{ name: "target_property", label: proseText("Value") }],
			},
		],
		modules: {
			[MODULE]: {
				uuid: MODULE,
				id: "target_module",
				name: "Target module",
				caseType: "target_case",
				caseListConfig: {
					columns: [plainColumn(COLUMN, "target_property", "Target column")],
					listColumnOrder: [COLUMN],
					detailColumnOrder: [COLUMN],
					searchInputs: [
						simpleSearchInputDef(
							INPUT,
							"target_input",
							"Target input",
							"text",
							"target_property",
						),
					],
				},
			},
		},
		forms: {
			[FORM]: {
				uuid: FORM,
				id: "target_form",
				name: "Target form",
				type: "followup",
			},
		},
		fields: {
			[FIELD]: {
				uuid: FIELD,
				id: "target_field",
				kind: "text",
				label: proseText("Target field"),
			},
		},
		moduleOrder: [MODULE],
		formOrder: { [MODULE]: [FORM] },
		fieldOrder: { [FORM]: [FIELD] },
		fieldParent: { [FIELD]: FORM },
	};
	assertAdmittedDoc(doc);
	return doc;
}

describe("searchBlueprint identity projection", () => {
	it("returns one exact, type-specific UUID address and module topology", () => {
		const results = searchBlueprint(identityFixture(), "Target");

		expect(results).toHaveLength(7);
		expect(results.map(({ type }) => type)).toEqual([
			"module",
			"module",
			"case_list_column",
			"search_input",
			"form",
			"field",
			"field",
		]);

		const addresses = results.map((result) => {
			const {
				field: _field,
				value: _value,
				context: _context,
				...address
			} = result;
			return address;
		});
		expect(addresses).toEqual([
			{
				type: "module",
				moduleUuid: MODULE,
				parentModuleUuid: null,
				childModuleUuids: [],
			},
			{
				type: "module",
				moduleUuid: MODULE,
				parentModuleUuid: null,
				childModuleUuids: [],
			},
			{ type: "case_list_column", moduleUuid: MODULE, columnUuid: COLUMN },
			{ type: "search_input", moduleUuid: MODULE, searchInputUuid: INPUT },
			{ type: "form", moduleUuid: MODULE, formUuid: FORM },
			{
				type: "field",
				moduleUuid: MODULE,
				formUuid: FORM,
				fieldUuid: FIELD,
			},
			{
				type: "field",
				moduleUuid: MODULE,
				formUuid: FORM,
				fieldUuid: FIELD,
			},
		]);
	});

	it("keeps follow-up addresses stable after field and form identifiers change", () => {
		const doc = identityFixture();
		const verdict = mutationCommitVerdict(
			doc,
			[
				{ kind: "renameForm", uuid: FORM, newId: "renamed_form" },
				{
					kind: "updateField",
					uuid: FIELD,
					targetKind: "text",
					patch: { id: "renamed_field" },
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		const result = searchBlueprint(verdict.nextDoc, "Target field");
		expect(result).toEqual([
			{
				type: "field",
				moduleUuid: MODULE,
				formUuid: FORM,
				fieldUuid: FIELD,
				field: "label",
				value: "Target field",
				context:
					'Menu "Target module" > Form "renamed_form" > Field "renamed_field" (text)',
			},
		]);
	});
});
