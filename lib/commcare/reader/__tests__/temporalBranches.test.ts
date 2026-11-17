/**
 * A value-giving branch (`if`, `coalesce`, `switch`) around a case property
 * of a date or a date and time, in each record slot that reads the menu's
 * case, reads back from Nova's own export to the document that made it.
 *
 * Contract: for each admitted document below, a first reading of its export
 * (told no property's type, as a bring-in is) and a read back of it (told
 * the document's own, as acceptance's fixed point is) read with no finding,
 * and each gives the slot's canonical tree; the read back gives the whole
 * canonical document (`canon.ts::canonDocument`).
 *
 * Plausible failures: a first reading that leaves a property untyped where
 * it stands only in a branch, so the checker refuses the branches' types
 * (`branch-values`) or the ordering of text (`ordered-values`); a literal
 * branch or a `datetime-coerce` of a literal, which print as the typed
 * literal does, read as text, so the branches disagree; a `switch` of
 * several cases inside a comparison of moments read as the `if`s it prints;
 * a property a first reading types `date` for a date range Search field over
 * it, though a record slot compares it with a date and time.
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
import {
	type BlueprintDoc,
	calculatedColumn,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	coalesce,
	datetimeCoerce,
	type Expression,
	eq,
	gt,
	ifExpr,
	isBlank,
	literal,
	lte,
	now,
	prop,
	switchCase,
	switchExpr,
	term,
	today,
} from "@/lib/domain/expression";
import { canonDocument } from "../canon";
import { readHqApp } from "../index";
import type { ReadOutcome } from "../types";
import { exportedBody, inputFor } from "./novaExport";

const SEEN = term(prop("visit", "seen"));
const NOTE = term(prop("visit", "note"));
const COLUMN = testUuid("temporal-branch-column");

const typedLiteral = (value: string, dataType: "date" | "datetime") =>
	term({ kind: "literal", value, data_type: dataType });
const dateLiteral = (value: string) => term(literal(value));

type Slot = "form" | "filter" | "column";

/** A follow-up of `visit` cases, `seen` of `seenType` and `note` untyped,
 *  holding `expression` in `slot`. */
function visitDoc(
	slot: Slot,
	expression: Expression,
	seenType: "date" | "datetime",
): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	const column = calculatedColumn(COLUMN, "Seen", expression);
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
				: config;
	return buildDoc({
		caseTypes: [
			{
				name: "visit",
				properties: [
					{ name: "seen", label: proseText("Seen"), data_type: seenType },
					{ name: "note", label: proseText("Note") },
				],
			},
		],
		modules: [
			{
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseList,
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

/** The expression `slot` holds in `doc`. */
function slotTree(doc: BlueprintDoc, slot: Slot): Expression | undefined {
	const module = Object.values(doc.modules)[0];
	if (slot === "filter") return module?.caseListConfig?.filter;
	if (slot === "column") {
		// A first reading mints the column's UUID; it is the list's second.
		const column = module?.caseListConfig?.columns.find(
			(one) => one.kind === "calculated",
		);
		return column !== undefined && "expression" in column
			? column.expression
			: undefined;
	}
	return Object.values(doc.forms)[0]?.displayCondition;
}

function read(outcome: ReadOutcome): BlueprintDoc {
	if (outcome.kind !== "read")
		throw new Error(
			`The reading is an account: ${outcome.findings
				.map((one) => `${one.code} (${one.detail.reason ?? ""})`)
				.join("; ")}`,
		);
	expect(outcome.defects).toEqual([]);
	return outcome.draft.doc;
}

/** Each shape as a condition, and the value it compares where a calculated
 *  column holds a value. */
const SHAPES: readonly {
	readonly name: string;
	readonly condition: Expression;
	readonly seenType?: "date";
	/** As a calculated column's value, the property stands beside literals
	 *  alone, which a first reading reads as text: no export says the
	 *  property is a date, and text beside text prints the same bytes. */
	readonly untypedAsValue?: true;
}[] = [
	{
		name: "coalesce(seen, now()) > now()",
		condition: gt(coalesce(SEEN, now()), now()),
	},
	{
		name: "coalesce(now(), seen) > now()",
		condition: gt(coalesce(now(), SEEN), now()),
	},
	{
		name: "if(blank(note), seen, now()) <= now()",
		condition: lte(ifExpr(isBlank(NOTE), SEEN, now()), now()),
	},
	{
		name: "if(blank(note), seen, seen) > now()",
		condition: gt(ifExpr(isBlank(NOTE), SEEN, SEEN), now()),
	},
	{
		name: "a switch of one case, seen or now()",
		condition: gt(
			switchExpr(NOTE, [switchCase(literal("a"), SEEN)], now()),
			now(),
		),
	},
	{
		name: "a switch of two cases, seen or now()",
		condition: gt(
			switchExpr(
				NOTE,
				[switchCase(literal("a"), SEEN), switchCase(literal("b"), SEEN)],
				now(),
			),
			now(),
		),
	},
	{
		name: "a switch with a literal result",
		condition: gt(
			switchExpr(
				NOTE,
				[
					switchCase(
						literal("a"),
						typedLiteral("2026-01-02T10:00:00+01:00", "datetime"),
					),
					switchCase(literal("b"), SEEN),
				],
				now(),
			),
			now(),
		),
	},
	{
		name: "coalesce(seen, a literal) > now()",
		condition: gt(
			coalesce(SEEN, typedLiteral("2026-01-01T00:00:00Z", "datetime")),
			now(),
		),
		untypedAsValue: true,
	},
	{
		name: "if(blank(note), a literal, seen) > now()",
		condition: gt(
			ifExpr(
				isBlank(NOTE),
				typedLiteral("2026-01-01T00:00:00Z", "datetime"),
				SEEN,
			),
			now(),
		),
		untypedAsValue: true,
	},
	{
		name: "coalesce(seen, datetime-coerce of a date) > now()",
		condition: gt(
			coalesce(SEEN, datetimeCoerce(dateLiteral("2026-01-01"))),
			now(),
		),
		untypedAsValue: true,
	},
	{
		name: "datetime-coerce of a date > seen",
		condition: gt(datetimeCoerce(dateLiteral("2026-01-01")), SEEN),
	},
	{
		name: "coalesce(seen, now()) = now()",
		condition: eq(coalesce(SEEN, now()), now()),
	},
	{
		name: "coalesce(seen, today()) > today(), seen a date",
		condition: gt(coalesce(SEEN, today()), today()),
		seenType: "date",
	},
	{
		name: "coalesce(seen, a date literal) > today(), seen a date",
		condition: gt(coalesce(SEEN, typedLiteral("2026-01-01", "date")), today()),
		seenType: "date",
		untypedAsValue: true,
	},
];

describe("a value-giving branch around a date or a date and time, read back", () => {
	for (const slot of ["form", "filter", "column"] as const)
		for (const shape of SHAPES) {
			const expression =
				slot === "column" && shape.condition.kind !== "eq"
					? (shape.condition as { readonly left: Expression }).left
					: shape.condition;
			if (slot === "column" && shape.condition.kind === "eq") continue;
			it(`${shape.name}, in the ${slot === "form" ? "form's display condition" : slot === "filter" ? "case list's filter" : "calculated column"}`, async () => {
				const doc = visitDoc(slot, expression, shape.seenType ?? "datetime");
				expect(
					runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map(
						(error) => error.code,
					),
				).toEqual([]);
				const canonical = canonDocument(doc);

				const first = read(readHqApp(await inputFor(exportedBody(doc))));
				if (slot !== "column" || shape.untypedAsValue !== true)
					expect(slotTree(first, slot)).toEqual(slotTree(canonical, slot));

				const outcome = readHqApp(await readBackInput(doc, servedExport(doc)));
				const back = read(outcome);
				const { declaration } =
					outcome.kind === "read" ? outcome.draft : { declaration: undefined };
				expect(
					readBackDifferences(canonical, {
						doc: back,
						choices: declaration?.kind === "choices" ? declaration.choices : [],
					}),
				).toEqual([]);
			});
		}
});

describe("a calculated column that is a datetime-coerce of a date", () => {
	it("reads back as the text it prints", async () => {
		const doc = visitDoc(
			"column",
			datetimeCoerce(dateLiteral("2026-01-01")),
			"datetime",
		);
		const back = read(readHqApp(await readBackInput(doc, servedExport(doc))));
		expect(slotTree(back, "column")).toEqual(
			term(literal("2026-01-01T00:00:00.000Z")),
		);
		expect(slotTree(canonDocument(doc), "column")).toEqual(
			slotTree(back, "column"),
		);
	});
});

describe("a date range Search field over a date and time a record slot compares", () => {
	it("is a date and time in a first reading, as the comparison says", async () => {
		const base = visitDoc("column", coalesce(SEEN, now()), "datetime");
		const doc = buildDoc({
			caseTypes: base.caseTypes ?? [],
			modules: [
				{
					name: "Visits",
					caseType: "visit",
					caseListConfig: {
						...(Object.values(base.modules)[0]?.caseListConfig ??
							caseListConfig([])),
						searchInputs: [
							simpleSearchInputDef(
								testUuid("temporal-branch-seen-range"),
								"seen",
								"Seen",
								"date-range",
								"seen",
							),
						],
					},
					caseSearchConfig: {},
					forms: [
						{
							name: "Check",
							type: "followup",
							displayCondition: gt(SEEN, now()),
							fields: [f({ kind: "text", id: "answer" })],
						},
					],
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((error) => error.code),
		).toEqual([]);
		const first = read(readHqApp(await inputFor(exportedBody(doc))));
		expect(
			first.caseTypes
				?.find((type) => type.name === "visit")
				?.properties.find((property) => property.name === "seen")?.data_type,
		).toBe("datetime");
		expect(slotTree(first, "column")).toEqual(coalesce(SEEN, now()));
		expect(slotTree(first, "form")).toEqual(gt(SEEN, now()));
	});
});
