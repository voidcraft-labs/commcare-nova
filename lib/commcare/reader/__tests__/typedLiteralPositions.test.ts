/**
 * A typed date or date-and-time literal at each position of a record slot a
 * device reads, read from Nova's own export, gives the document's canonical
 * form, and that form prints the export byte for byte.
 *
 * Contract: for each shape of `typedLiteralArbitrary.ts`'s tables, in each
 * slot of its family (a calculated column; a case list's filter and a form's
 * display condition, which read the menu's case; a menu's display condition;
 * a date Search field's starting value), a document the gate admits prints
 * the same export as its canonical form (`canon.ts::canonDocument`), a first
 * reading of that export (told no property's type, as a bring-in is) reads
 * with no finding and no defect, and a read back (told the document's own,
 * as acceptance's fixed point is) gives the canonical document. A shape the
 * gate refuses in a slot holds no position there and is passed by.
 *
 * Plausible failures: a literal a position requires typed (`format-date`'s
 * date, `date-add`'s, a branch of a date Search field's starting value, an
 * ordering against a property no export types) read untyped, which the
 * checker refuses; a literal no position requires typed (the value of
 * `date()`) left typed by the canonical form while the reading gives the
 * text; a canonical form that prints another export than the document.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	CONDITION_SHAPES,
	DATE_DEFAULT_SHAPES,
	GLOBAL_CONDITION_SHAPES,
	type ShapeScope,
	type TypedLiteralShape,
	VALUE_SHAPES,
} from "@/lib/commcare/__tests__/typedLiteralArbitrary";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import {
	readBackInput,
	servedExport,
} from "@/lib/deployment/reading/__tests__/novaReading";
import { readBackDifferences } from "@/lib/deployment/reading/readBack";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type CaseProperty,
	calculatedColumn,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression";
import { canonDocument } from "../canon";
import { readHqApp } from "../index";
import { whereText } from "../place";
import type { ReadOutcome } from "../types";
import { exportedBody, inputFor } from "./novaExport";

type Slot = "column" | "filter" | "form" | "menu" | "starting value";

const SCOPE: ShapeScope = {
	caseType: "visit",
	parentType: "household",
	literals: {
		day: "2026-01-01",
		otherDay: "2026-02-01",
		moment: "2026-01-01T00:00:00Z",
		otherMoment: "2026-02-01T10:00:00+01:00",
	},
};

const POOL: CaseProperty[] = [
	{ name: "visit_date", label: proseText("Day"), data_type: "date" },
	{ name: "last_seen", label: proseText("Seen"), data_type: "datetime" },
	{ name: "full_name", label: proseText("Name"), data_type: "text" },
];

/** A follow-up menu of `visit` cases, children of `household`, holding
 *  `expression` in `slot`. */
function visitDoc(slot: Slot, expression: Expression): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	const column = calculatedColumn(
		testUuid("typed-column"),
		"Typed",
		expression,
	);
	const caseList =
		slot === "column"
			? {
					...config,
					columns: [...config.columns, column],
					listColumnOrder: [...config.listColumnOrder, column.uuid],
					detailColumnOrder: [...config.detailColumnOrder, column.uuid],
				}
			: slot === "filter"
				? { ...config, filter: expression }
				: slot === "starting value"
					? {
							...config,
							searchInputs: [
								simpleSearchInputDef(
									testUuid("typed-input"),
									"day",
									"Day",
									"date",
									"visit_date",
									{ default: expression },
								),
							],
						}
					: config;
	return buildDoc({
		caseTypes: [
			{ name: "household", properties: POOL },
			{ name: "visit", parent_type: "household", properties: POOL },
		],
		modules: [
			{
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseList,
				...(slot === "starting value" ? { caseSearchConfig: {} } : {}),
				...(slot === "menu" ? { displayCondition: expression } : {}),
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

function accountOf(outcome: ReadOutcome): string | null {
	if (outcome.defects.length > 0)
		return `reader defect: ${JSON.stringify(outcome.defects[0])}`;
	if (outcome.kind !== "read")
		return outcome.findings
			.map(
				(one) =>
					`${one.code} at ${whereText(one.place)} (${one.detail.reason ?? ""})`,
			)
			.join("; ");
	return null;
}

const FAMILIES: readonly (readonly [Slot, readonly TypedLiteralShape[]])[] = [
	["column", VALUE_SHAPES],
	["filter", [...CONDITION_SHAPES, ...GLOBAL_CONDITION_SHAPES]],
	["form", [...CONDITION_SHAPES, ...GLOBAL_CONDITION_SHAPES]],
	["menu", GLOBAL_CONDITION_SHAPES],
	["starting value", DATE_DEFAULT_SHAPES],
];

describe("a typed date or date-and-time literal at each position, read back", () => {
	for (const [slot, shapes] of FAMILIES)
		for (const one of shapes)
			it(`${one.name}, in the ${slot}, where the gate admits it`, async () => {
				const expression = one.build(SCOPE);
				if (expression === undefined) return;
				const doc = visitDoc(slot, expression);
				if (runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).length > 0) return;
				const canonical = canonDocument(doc);
				expect(JSON.stringify(expandDoc(canonical))).toBe(
					JSON.stringify(expandDoc(doc)),
				);

				const first = readHqApp(await inputFor(exportedBody(doc)));
				expect(accountOf(first)).toBeNull();

				const outcome = readHqApp(await readBackInput(doc, servedExport(doc)));
				expect(accountOf(outcome)).toBeNull();
				if (outcome.kind !== "read") return;
				const { declaration } = outcome.draft;
				expect(
					readBackDifferences(canonical, {
						doc: outcome.draft.doc,
						choices: declaration.kind === "choices" ? declaration.choices : [],
					}),
				).toEqual([]);
			});
});
