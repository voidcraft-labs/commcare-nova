/**
 * A first reading types a property a record slot reads only through a
 * coercion or a function of two untyped properties, as the source prints it.
 *
 * Contract: a first reading of each admitted document below (told no
 * property's type, as a bring-in is) reads with no finding and no reader
 * defect, and a read back of it (told the document's own) gives the
 * document's canonical form.
 *
 * Plausible failures: a property a `datetime-coerce` reads left text, so the
 * reading prints the coercion of text where the source prints the coercion
 * of a date; and the date and the quantity of a `date-add` over two untyped
 * properties each tried alone, which the checker admits neither of, so
 * neither is typed and the reading cannot print the source; and a property
 * compared with a branch node whose other branch a number types only once
 * the comparison types it, so the two are left of types the checker refuses
 * to compare; a property of the case a menu above chose, ordered against
 * a moment, left text; and a read of that case in a form's display condition
 * taken for a read of the form's own case, whose type lacks the property.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import {
	readBackInput,
	servedExport,
} from "@/lib/deployment/reading/__tests__/novaReading";
import { readBackDifferences } from "@/lib/deployment/reading/readBack";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, calculatedColumn, proseText } from "@/lib/domain";
import {
	datetimeCoerce,
	type Expression,
	eq,
	gt,
	gte,
	ifExpr,
	isIn,
	literal,
	lte,
	now,
	prop,
	switchCase,
	switchExpr,
	term,
} from "@/lib/domain/expression";
import { chosenCaseProperty } from "@/lib/domain/expression/chosenCase";
import { canonDocument } from "../canon";
import { mintingResolver } from "../identity";
import { readHqApp } from "../index";

const COLUMN = testUuid("first-reading-types-column");
const HOUSEHOLDS = "first-reading-types-households";

/** A follow-up of `visit` cases, `seen` a date, `age` a whole number and
 *  `weight` a decimal,
 *  holding `expression` in the form's display condition or a calculated
 *  column. */
function visitDoc(slot: "form" | "column", expression: Expression) {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	const column = calculatedColumn(COLUMN, "Due", expression);
	return buildDoc({
		caseTypes: [
			{
				name: "visit",
				properties: [
					{ name: "seen", label: proseText("Seen"), data_type: "date" },
					{ name: "age", label: proseText("Age"), data_type: "int" },
					{ name: "weight", label: proseText("Weight"), data_type: "decimal" },
				],
			},
		],
		modules: [
			{
				name: "Visits",
				caseType: "visit",
				caseListConfig:
					slot === "column"
						? {
								...config,
								columns: [...config.columns, column],
								listColumnOrder: [...config.listColumnOrder, column.uuid],
								detailColumnOrder: [...config.detailColumnOrder, column.uuid],
							}
						: config,
				forms: [
					{
						name: "Check",
						type: "followup",
						...(slot === "form" ? { displayCondition: expression } : {}),
						fields: [f({ kind: "text", id: "answer" })],
					},
				],
			},
		],
	});
}

/** Households, `last_seen` a date and time, and their visits listed after a
 *  household is chosen, filtered by `filter`, the visit's form shown on
 *  `display`. */
function routedDoc(filter: Expression, display?: Expression) {
	const config = () => caseListConfig([{ field: "case_name", header: "Name" }]);
	return buildDoc({
		caseTypes: [
			{
				name: "household",
				properties: [
					{
						name: "last_seen",
						label: proseText("Last seen"),
						data_type: "datetime",
					},
					{ name: "size", label: proseText("Size"), data_type: "int" },
				],
			},
			{
				name: "visit",
				parent_type: "household",
				properties: [
					{ name: "seen", label: proseText("Seen"), data_type: "date" },
					{
						name: "weight",
						label: proseText("Weight"),
						data_type: "decimal",
					},
				],
			},
		],
		modules: [
			{
				uuid: HOUSEHOLDS,
				name: "Households",
				caseType: "household",
				caseListConfig: config(),
				forms: [
					{
						name: "Check",
						type: "followup",
						fields: [f({ kind: "text", id: "note" })],
					},
				],
			},
			{
				name: "Visits",
				caseType: "visit",
				parentCaseModuleUuid: HOUSEHOLDS,
				caseListConfig: { ...config(), filter },
				forms: [
					{
						name: "Review",
						type: "followup",
						...(display === undefined ? {} : { displayCondition: display }),
						fields: [f({ kind: "text", id: "answer" })],
					},
				],
			},
		],
	});
}

const SEEN = term(prop("visit", "seen"));
const AGE = term(prop("visit", "age"));
const WEIGHT = term(prop("visit", "weight"));

const CASES: readonly {
	readonly name: string;
	readonly doc: BlueprintDoc;
}[] = [
	{
		name: "a switch on the coercion of a date, against moments",
		doc: visitDoc(
			"form",
			lte(
				now(),
				switchExpr(
					datetimeCoerce(SEEN),
					[
						switchCase(
							{
								kind: "literal",
								value: "2026-02-01T10:00:00+01:00",
								data_type: "datetime",
							},
							now(),
						),
					],
					now(),
				),
			),
		),
	},
	{
		name: "the coercion of a date-add of a date and a whole number",
		doc: visitDoc(
			"column",
			datetimeCoerce({
				kind: "date-add",
				date: SEEN,
				interval: "days",
				quantity: AGE,
			}),
		),
	},
	{
		name: "a comparison of a property with a branch node that reads another beside a number",
		doc: visitDoc(
			"form",
			eq(
				ifExpr(isIn(term(literal("a")), literal("a")), AGE, term(literal(3))),
				WEIGHT,
			),
		),
	},
	{
		name: "a form shown on a property of the case a menu above chose, which the form's own type lacks",
		doc: routedDoc(
			{ kind: "match-all" },
			gte(
				datetimeCoerce(
					term({
						kind: "literal",
						value: "2026-01-01T00:00:00Z",
						data_type: "datetime",
					}),
				),
				chosenCaseProperty(testUuid(HOUSEHOLDS), "household", "last_seen"),
			),
		),
	},
	{
		name: "an ordering of an untyped property against one of the case a menu above chose",
		doc: routedDoc(
			{ kind: "match-all" },
			gte(
				term(prop("visit", "weight")),
				chosenCaseProperty(testUuid(HOUSEHOLDS), "household", "size"),
			),
		),
	},
	{
		name: "an ordering of a property of the case a menu above chose",
		doc: routedDoc(
			gt(
				now(),
				chosenCaseProperty(testUuid(HOUSEHOLDS), "household", "last_seen"),
			),
		),
	},
];

describe("a first reading of a property only a coercion or a function reads", () => {
	for (const one of CASES)
		it(one.name, { timeout: 30_000 }, async () => {
			expect(
				runValidation(one.doc, LOOKUP_CONTEXT_UNAVAILABLE).map(
					(error) => error.code,
				),
			).toEqual([]);
			const input = await readBackInput(one.doc, servedExport(one.doc));
			const {
				knownCaseTypes: _types,
				knownLanguageCodes: _codes,
				...told
			} = input;
			const first = readHqApp({
				...told,
				resolver: mintingResolver(one.doc.appId),
			});
			expect(first.defects).toEqual([]);
			expect(first.kind === "account" ? first.findings : []).toEqual([]);
			const back = readHqApp(input);
			if (back.kind !== "read") throw new Error("The read back is an account.");
			const { declaration } = back.draft;
			expect(
				readBackDifferences(canonDocument(one.doc), {
					doc: back.draft.doc,
					choices: declaration.kind === "choices" ? declaration.choices : [],
				}),
			).toEqual([]);
		});
});
