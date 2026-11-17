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
 * neither is typed and the reading cannot print the source.
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
	lte,
	now,
	prop,
	switchCase,
	switchExpr,
	term,
} from "@/lib/domain/expression";
import { canonDocument } from "../canon";
import { mintingResolver } from "../identity";
import { readHqApp } from "../index";

const COLUMN = testUuid("first-reading-types-column");

/** A follow-up of `visit` cases, `seen` a date and `age` a whole number,
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

const SEEN = term(prop("visit", "seen"));
const AGE = term(prop("visit", "age"));

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
];

describe("a first reading of a property only a coercion or a function reads", () => {
	for (const one of CASES)
		it(one.name, async () => {
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
