/**
 * Record slots that print alike in two spellings, or that a first reading
 * must type properties for, read back as the document's canonical form, on a
 * first reading and on a read back alike.
 *
 * Contract: each document below is admitted by the commit gate; a first
 * reading of its export (told no property's type, as a bring-in is) reads
 * with no finding and no reader defect, and a read back of it (told the
 * document's own types) gives `canonDocument` of it.
 *
 * Plausible failures: a time literal in a branch beside a branch that gives a
 * time, read untyped beside it, so the branch node gives values of two types
 * and the reading is refused (`branch-values`); a list filter its search
 * restates read as a range where the search prints the two comparisons as two
 * rows, or as two comparisons where it prints one parenthesized range; a
 * first reading that leaves a property ordered only against a branch node of
 * properties as text, which the checker orders no more; a `null` compared
 * with a date read as the blank text it prints as, which the checker compares
 * with no date; and a first reading that
 * types a distance test's measured property a location but leaves a property
 * its center ends with text, so the center's branches disagree; and an
 * advanced Search field's condition that waits for another field, which the
 * list filter its search restates holds, read with the case property on the
 * left as the restating row spells it while the canonical form keeps the
 * literal there; and a list filter its search restates whose device reading
 * folds two top-level comparisons into a range (of a value that reads no
 * case, or of a date and time from a value to itself) where the search prints
 * them as two rows, or keeps a range's two comparisons as two clauses the row
 * restates one of in another spelling; and a switch on a value a device
 * works out, which a search's row prints as a chain of the device's choices,
 * read as that chain of `if`s.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { canonDocument } from "@/lib/commcare/reader/canon";
import { mintingResolver } from "@/lib/commcare/reader/identity";
import { readHqApp } from "@/lib/commcare/reader/index";
import { runValidation } from "@/lib/commcare/validator/runner";
import {
	readBackInput,
	servedExport,
} from "@/lib/deployment/reading/__tests__/novaReading";
import { readBackDifferences } from "@/lib/deployment/reading/readBack";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	proseText,
	type SearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import { type Expression, prop, term } from "@/lib/domain/expression";
import { uuid } from "../../caseList/__tests__/fixtures";

/** A follow-up of `visit` cases (`visit_time` a time, `seen` a date,
 *  `last_seen` a date and time, `home` and `other_home` locations, `notes`
 *  and `phone` text) whose form shows on `display`, whose list is filtered by
 *  `filter` and searched by `searchInputs`. */
function visitDoc(slots: {
	readonly display?: Expression;
	readonly filter?: Expression;
	readonly searchInputs?: SearchInputDef[];
}): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{
				name: "visit",
				properties: [
					{
						name: "visit_time",
						label: proseText("Visit time"),
						data_type: "time",
					},
					{ name: "seen", label: proseText("Seen"), data_type: "date" },
					{
						name: "last_seen",
						label: proseText("Last seen"),
						data_type: "datetime",
					},
					{ name: "home", label: proseText("Home"), data_type: "geopoint" },
					{
						name: "other_home",
						label: proseText("Other home"),
						data_type: "geopoint",
					},
					{ name: "notes", label: proseText("Notes"), data_type: "text" },
					{ name: "phone", label: proseText("Phone"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				name: "Visits",
				caseType: "visit",
				caseListConfig: {
					...caseListConfig([{ field: "case_name", header: "Name" }]),
					...(slots.filter === undefined ? {} : { filter: slots.filter }),
					...(slots.searchInputs === undefined
						? {}
						: { searchInputs: slots.searchInputs }),
				},
				...(slots.searchInputs === undefined ? {} : { caseSearchConfig: {} }),
				forms: [
					{
						name: "Check",
						type: "followup",
						...(slots.display === undefined
							? {}
							: { displayCondition: slots.display }),
						fields: [f({ kind: "text", id: "answer" })],
					},
				],
			},
		],
	});
}

const seen = term(prop("visit", "seen"));
const lastSeen = term(prop("visit", "last_seen"));
const day = term({ kind: "literal", value: "2026-01-01", data_type: "date" });
const now: Expression = { kind: "now" };
const today: Expression = { kind: "today" };
const nextMonth = term({
	kind: "literal",
	value: "2026-02-01",
	data_type: "date",
});
const moment = term({
	kind: "literal",
	value: "2026-01-01T00:00:00Z",
	data_type: "datetime",
});
const notesX: Expression = {
	kind: "eq",
	left: term(prop("visit", "notes")),
	right: term({ kind: "literal", value: "x" }),
};
const daySpan: Expression = {
	kind: "between",
	left: seen,
	lower: day,
	upper: day,
	lowerInclusive: true,
	upperInclusive: true,
};

/** A switch on a number the device works out, a case for each of `whens`,
 *  each but the first a test of the case, falling back to a test of the
 *  case's notes. */
function deviceSwitch(whens: readonly number[]): Expression {
	const [first, ...rest] = whens.map((when, index) => ({
		when: { kind: "literal" as const, value: when },
		// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
		then:
			index === 0
				? ({ kind: "match-all" } as Expression)
				: ({
						kind: "eq",
						left: term(prop("visit", "notes")),
						right: term({ kind: "literal", value: `n${index}` }),
					} as Expression),
	}));
	if (first === undefined) throw new Error("A switch needs a case.");
	return {
		kind: "switch",
		on: {
			kind: "negate",
			value: term({ kind: "literal", value: -2 }),
		},
		cases: [first, ...rest],
		fallback: notesX,
	};
}

const CASES: readonly { readonly name: string; readonly doc: BlueprintDoc }[] =
	[
		{
			name: "a membership of a time literal in a coalesce of a time literal and a time",
			doc: visitDoc({
				display: {
					kind: "in",
					left: {
						kind: "coalesce",
						values: [
							term({ kind: "literal", value: "10:30", data_type: "time" }),
							term(prop("visit", "visit_time")),
						],
					},
					values: [{ kind: "literal", value: "10:30", data_type: "time" }],
				},
			}),
		},
		{
			// A distance test whose center is a switch over two locations, one
			// of them the measured property.
			name: "a distance test from a property to a switch over two locations",
			doc: visitDoc({
				filter: {
					kind: "within-distance",
					property: prop("visit", "home"),
					center: {
						kind: "switch",
						on: term({ kind: "literal", value: "a" }),
						cases: [
							{
								when: { kind: "literal", value: "a" },
								// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
								then: term(prop("visit", "home")),
							},
						],
						fallback: term(prop("visit", "other_home")),
					},
					distance: 2.5,
					unit: "centimeters",
				},
			}),
		},
		{
			// The field's condition holds a literal on the left.
			name: "an advanced field's condition that waits for another field and holds a literal on the left",
			doc: visitDoc({
				searchInputs: [
					{
						uuid: uuid(9),
						name: "number",
						label: "Number",
						kind: "advanced",
						type: "text",
						predicate: {
							kind: "when-input-present",
							input: { kind: "input", searchInputUuid: uuid(8) },
							clause: {
								kind: "eq",
								left: term({ kind: "literal", value: "x" }),
								right: term(prop("visit", "notes")),
							},
						},
					},
					simpleSearchInputDef(uuid(8), "phone", "Phone", "text", "phone"),
				],
			}),
		},
		{
			// The list's own filter prints the range and the two comparisons
			// alike; its search prints the two as two rows and the range as one.
			name: "a searched list's filter of a lower and an upper bound's comparisons",
			doc: visitDoc({
				filter: {
					kind: "and",
					clauses: [
						{ kind: "gte", left: seen, right: day },
						{ kind: "lte", left: seen, right: day },
					],
				},
				searchInputs: [],
			}),
		},
		{
			name: "a searched list's filter of a range of days",
			doc: visitDoc({ filter: daySpan, searchInputs: [] }),
		},
		{
			name: "a searched list's filter of a range from now to now, the upper bound left out",
			doc: visitDoc({
				filter: {
					kind: "between",
					left: lastSeen,
					lower: now,
					upper: now,
					lowerInclusive: true,
					upperInclusive: false,
				},
				searchInputs: [],
			}),
		},
		{
			// A date and time's range from a value to itself prints the row its
			// equality prints, which the row reads as.
			name: "a searched list's filter of a range from now to now",
			doc: visitDoc({
				filter: {
					kind: "between",
					left: lastSeen,
					lower: now,
					upper: now,
					lowerInclusive: true,
					upperInclusive: true,
				},
				searchInputs: [],
			}),
		},
		{
			// A range that reads no case is worked out on the device whole, one
			// row of the search, which a device's value holds.
			name: "a searched list's filter of a range of today, the upper bound left out",
			doc: visitDoc({
				filter: {
					kind: "between",
					left: { kind: "today" },
					lower: { kind: "today" },
					upper: {
						kind: "date-coerce",
						value: term({
							kind: "literal",
							value: "2026-01-01T00:00:00Z",
							data_type: "datetime",
						}),
					},
					lowerInclusive: true,
					upperInclusive: false,
				},
				searchInputs: [],
			}),
		},
		{
			// The row reads the range with the literal as the search spells it,
			// where the device's reading folds it to its moment's text.
			name: "a searched list's filter of a range from a moment to now, the upper bound left out",
			doc: visitDoc({
				filter: {
					kind: "between",
					left: lastSeen,
					lower: moment,
					upper: now,
					lowerInclusive: true,
					upperInclusive: false,
				},
				searchInputs: [],
			}),
		},
		{
			name: "a searched list's filter of a range from now to a moment, the upper bound left out",
			doc: visitDoc({
				filter: {
					kind: "between",
					left: lastSeen,
					lower: now,
					upper: moment,
					lowerInclusive: true,
					upperInclusive: false,
				},
				searchInputs: [],
			}),
		},
		{
			// Each top-level comparison is a row the device works out, though
			// neither reads a case.
			name: "a searched list's filter of two comparisons of today",
			doc: visitDoc({
				filter: {
					kind: "and",
					clauses: [
						{ kind: "gte", left: today, right: day },
						{ kind: "lt", left: today, right: nextMonth },
					],
				},
				searchInputs: [],
			}),
		},
		{
			// Two rows, where the range from the moment to itself is one.
			name: "a searched list's filter of a lower and an upper bound's comparisons of a date and time with one moment",
			doc: visitDoc({
				filter: {
					kind: "and",
					clauses: [
						{ kind: "gte", left: lastSeen, right: moment },
						{ kind: "lte", left: lastSeen, right: moment },
					],
				},
				searchInputs: [],
			}),
		},
		{
			name: "a searched list's filter of a lower and an upper bound's comparisons of a date and time with now",
			doc: visitDoc({
				filter: {
					kind: "and",
					clauses: [
						{ kind: "gte", left: lastSeen, right: now },
						{ kind: "lte", left: lastSeen, right: now },
					],
				},
				searchInputs: [],
			}),
		},
		{
			// The device chooses between the cases, each the `if` of its test,
			// as a chain of `if`s prints.
			name: "a searched list's filter of a switch on a value the device works out",
			doc: visitDoc({ filter: deviceSwitch([0, 3]), searchInputs: [] }),
		},
		{
			name: "a searched list's filter of a switch of three cases on a value the device works out",
			doc: visitDoc({ filter: deviceSwitch([0, 3, 4]), searchInputs: [] }),
		},
		{
			// Inside an `or` the search prints a range and its two comparisons
			// alike, parenthesized.
			name: "a searched list's filter of a range beside another test in an `or`",
			doc: visitDoc({
				filter: { kind: "or", clauses: [daySpan, notesX] },
				searchInputs: [],
			}),
		},
		{
			// A device prints `null` as the blank text, which the checker
			// compares with no date.
			name: "an equality of a branch node of a date with a null",
			doc: visitDoc({
				display: {
					kind: "eq",
					left: { kind: "coalesce", values: [seen, seen] },
					right: term({ kind: "literal", value: null }),
				},
			}),
		},
		{
			// A first reading tells no property's type, and the checker orders
			// none as text.
			name: "an ordering of a property against a branch node of the same property",
			doc: visitDoc({
				display: {
					kind: "gte",
					left: seen,
					right: { kind: "coalesce", values: [seen] },
				},
			}),
		},
	];

describe("record slots whose temporal values print alike in two spellings", () => {
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
			expect(back.defects).toEqual([]);
			if (back.kind !== "read")
				throw new Error(
					`The read back is an account: ${back.findings.map((finding) => finding.code).join(", ")}`,
				);
			const { declaration } = back.draft;
			expect(
				readBackDifferences(canonDocument(one.doc), {
					doc: back.draft.doc,
					choices: declaration.kind === "choices" ? declaration.choices : [],
				}),
			).toEqual([]);
		});
});
