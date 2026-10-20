/**
 * Expression chips come from the parse: each identity read whose spelling
 * is a machine name becomes a chip over its own span, reading as what the
 * person knows it by. The plausible failures: a chip over the wrong text
 * (a whole comparison, or a predicate hidden inside a chip), a case
 * property turned into a chip, and chips on a draft that does not parse.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { instanceReadFixture } from "@/lib/commcare/__tests__/instanceReadFixture";
import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import type { ExpressionSlotRef } from "@/lib/domain/expression/types";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { buildExpressionEditorContext } from "../expressionEditorContext";
import { expressionChips } from "../xpath-chips";

const ATTENDING = testUuid("chips-attending");
const CALC = testUuid("chips-calc");
const REGION = testUuid("chips-region");

const doc = buildDoc(
	{
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "status_note", label: "Status note" }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								uuid: ATTENDING,
								id: "a",
								kind: "single_select",
								label: "Attending today",
								options: [
									{ uuid: testUuid("chips-yes"), value: "yes", label: "Yes" },
									{ uuid: testUuid("chips-no"), value: "no", label: "No" },
								],
							}),
							f({ uuid: CALC, id: "calc", kind: "hidden" }),
						],
					},
				],
			},
		],
	},
	(built) => {
		built.userProperties = {
			[REGION]: { uuid: REGION, slug: "region", label: "Region" },
		};
		built.userPropertyOrder = [REGION];
	},
);

const RELEVANT: ExpressionSlotRef = {
	entity: "field",
	uuid: CALC,
	slot: "relevant",
};

function chips(text: string) {
	const context = buildExpressionEditorContext(
		doc,
		RELEVANT,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	return expressionChips(text, context).map((chip) => ({
		text: text.slice(chip.from, chip.to),
		label: chip.label,
		type: chip.type,
	}));
}

describe("expression chips", () => {
	it("shows a question by its label in every spelling, and a choice by its label", () => {
		for (const read of ["../a", "#form/a", "/data/a"])
			expect(chips(`${read}  =  'yes'`), read).toEqual([
				{ text: read, label: "Attending today", type: "form" },
				{ text: "'yes'", label: "Yes", type: "form" },
			]);
	});

	it("shows worker information by its label and leaves a case property as text", () => {
		expect(chips("#user/region = #patient/status_note")).toEqual([
			{ text: "#user/region", label: "Region", type: "user" },
		]);
		expect(
			chips("instance('commcaresession')/session/user/data/region != ''"),
		).toEqual([
			{
				text: "instance('commcaresession')/session/user/data/region",
				label: "Region",
				type: "user",
			},
		]);
	});

	it("shows a session value by what it holds", () => {
		const [chip] = chips(
			"instance('commcaresession')/session/data/case_id != ''",
		);
		expect(chip).toEqual({
			text: "instance('commcaresession')/session/data/case_id",
			label: "The case chosen in Patients",
			type: "case",
		});
	});

	it("draws no chip on text that does not parse", () => {
		expect(chips("../a = ")).toEqual([]);
		expect(chips("../missing = 'yes'")).toEqual([]);
	});

	it("shows a data table's path by the table's name and its columns by their labels, keeping the predicate as text", () => {
		const { doc: tables, table } = instanceReadFixture();
		const lookup: LookupValidationContext = {
			kind: "available",
			projectId: "project",
			projectRevision: parseLookupRevision("1"),
			definitions: [table],
		};
		const field = Object.values(tables.fields).find(
			(each) => each.id === "region_label",
		);
		if (field === undefined) throw new Error("No region_label fixture");
		const context = buildExpressionEditorContext(
			tables,
			{ entity: "field", uuid: field.uuid, slot: "calculate" },
			lookup,
		);
		const text =
			"instance('regions')/regions_list/regions[value = 'north'][1]/label";
		const [value, label] = table.columns;
		expect(
			expressionChips(text, context).map((chip) => ({
				text: text.slice(chip.from, chip.to),
				label: chip.label,
			})),
		).toEqual([
			{ text: "instance('regions')/regions_list/regions", label: table.name },
			{ text: "value", label: value.label },
			{ text: "label", label: label.label },
		]);
	});
});
