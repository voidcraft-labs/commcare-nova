// components/builder/shared/__tests__/csqlCardsValidByConstruction.test.ts
//
// The CSQL cards that take epoch days, values in `selected-*`, and the nine
// units with a distance or unit worked out at run time offer exactly what the commit gate admits. Each offer is the exact
// predicate the card's model commits, judged by `expressionEditVerdict` over
// real slot contexts: the advanced search condition (CommCare's server
// search and Postgres only), the search-enabled case list filter and the
// plain case list filter (a device evaluates both). No React renderer.

import { describe, expect, it } from "vitest";
import { expressionEditorFixture } from "@/__tests__/helpers/expressionEditorFixture";
import { testUuid } from "@/__tests__/helpers/uuid";
import { expressionEditVerdict } from "@/lib/doc/hooks/predicateVerdicts";
import {
	advancedSearchInputDef,
	type CaseType,
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain";
import {
	chosen,
	chosenCaseDoc,
} from "@/lib/domain/__tests__/chosenCaseFixture";
import {
	acceptsType,
	coerceOperandConstraint,
	DISTANCE_UNITS,
	dateCoerce,
	datetimeCoerce,
	double,
	type Expression,
	type ExpressionContext,
	eq,
	input,
	literal,
	matchAll,
	multiSelectAny,
	prop,
	slotContext,
	term,
	within,
} from "@/lib/domain/expression";
import { chosenCaseProperty } from "@/lib/domain/expression/chosenCase";
import { proseText } from "@/lib/domain/prose";
import {
	DISTANCE_UNIT_LABELS,
	DISTANCE_UNIT_VALUE_CONSTRAINT,
	DISTANCE_VALUE_CONSTRAINT,
	distanceSourceChoices,
} from "../distanceDraft";
import type { ExpressionChangeAdmission } from "../editorContext";
import {
	addMultiSelectValueOffer,
	deviceEvaluatesSlot,
	multiSelectValueConstraint,
	NO_RUNTIME_CHOICE_VALUE_REASON,
} from "../multiSelectModel";

const VISIT: CaseType = {
	name: "visit",
	properties: [
		{ name: "seen_on", label: proseText("Seen on"), data_type: "date" },
		{ name: "seen_at", label: proseText("Seen at"), data_type: "datetime" },
		{
			name: "tags",
			label: proseText("Tags"),
			data_type: "multi_select",
			options: [
				{ value: "urgent", label: proseText("Urgent") },
				{ value: "follow_up", label: proseText("Follow up") },
			],
		},
		{ name: "where", label: proseText("Where"), data_type: "geopoint" },
	],
};
const TEXT_INPUT = testUuid("csql-card-text");
const PICK_INPUT = testUuid("csql-card-pick");
const PICKS_INPUT = testUuid("csql-card-picks");
const TABLE = lookupTableIdSchema.parse("00000000-0000-7000-8000-0000000000a1");
const COLUMN = lookupColumnIdSchema.parse(
	"00000000-0000-7000-8000-0000000000a2",
);

type Carrier = "search-predicate" | "search-case-filter" | "case-filter";

/** A carrier of the fixture whose module also holds a number answer and a
 * one-choice and a several-choice answer, so every value source a card
 * offers has a real search input behind it. */
function slot(carrier: Carrier): {
	readonly context: ExpressionContext;
	readonly knownInputs: readonly {
		uuid: typeof TEXT_INPUT;
		name: string;
		data_type: "text";
	}[];
} {
	const fixture = expressionEditorFixture(carrier, {
		caseTypes: [VISIT],
		currentCaseType: "visit",
		knownInputs: [{ uuid: TEXT_INPUT, name: "words", data_type: "text" }],
	});
	const module = Object.values(fixture.doc.modules)[0];
	if (module?.caseListConfig === undefined)
		throw new Error("The fixture module has a case list.");
	const options = {
		kind: "lookup" as const,
		tableId: TABLE,
		valueColumnId: COLUMN,
		labelColumnId: COLUMN,
	};
	const doc = {
		...fixture.doc,
		modules: {
			...fixture.doc.modules,
			[module.uuid]: {
				...module,
				caseListConfig: {
					...module.caseListConfig,
					searchInputs: [
						...module.caseListConfig.searchInputs,
						advancedSearchInputDef(
							PICK_INPUT,
							"pick",
							"Pick",
							"select",
							matchAll(),
							{ options },
						),
						advancedSearchInputDef(
							PICKS_INPUT,
							"picks",
							"Picks",
							"multi-select",
							matchAll(),
							{ options },
						),
					],
				},
			},
		},
	};
	const lookupTables = new Map(fixture.lookupTables);
	lookupTables.set(TABLE, new Map([[COLUMN, "text"]]));
	const context = slotContext(doc, fixture.slot, lookupTables);
	if (context === undefined) throw new Error("The slot has a context.");
	return {
		context,
		knownInputs: [
			// A choice answer binds its value token as text
			// (`SEARCH_INPUT_RUNTIME_VALUE_TYPES`).
			{ uuid: TEXT_INPUT, name: "words", data_type: "text" },
			{ uuid: PICK_INPUT, name: "pick", data_type: "text" },
			{ uuid: PICKS_INPUT, name: "picks", data_type: "text" },
		],
	};
}

function admitted(candidate: Expression, context: ExpressionContext): boolean {
	return expressionEditVerdict(candidate, context).ok;
}

function admitter(context: ExpressionContext) {
	return (candidate: Expression): ExpressionChangeAdmission => {
		const verdict = expressionEditVerdict(candidate, context);
		return verdict.ok
			? { admitted: true }
			: { admitted: false, reason: verdict.reason };
	};
}

const CARRIERS: readonly Carrier[] = [
	"search-predicate",
	"search-case-filter",
	"case-filter",
];
const SEEN_ON = prop("visit", "seen_on");
const SEEN_AT = prop("visit", "seen_at");
const TAGS = prop("visit", "tags");
const WHERE = prop("visit", "where");

describe("the date card reads a number of days", () => {
	it("offers a number operand, and the gate admits whole days in every slot", () => {
		expect(acceptsType(coerceOperandConstraint(), "int")).toBe(true);
		expect(acceptsType(coerceOperandConstraint(), "decimal")).toBe(true);
		for (const carrier of CARRIERS) {
			const { context } = slot(carrier);
			expect(
				admitted(eq(SEEN_ON, dateCoerce(term(literal(19000)))), context),
				carrier,
			).toBe(true);
			expect(
				admitted(eq(SEEN_ON, dateCoerce(term(input(TEXT_INPUT)))), context),
				carrier,
			).toBe(true);
		}
	});

	it("leaves a fraction of a day to the gate, which refuses it where its position cannot hold one", () => {
		// A CSQL date counts whole days (`epoch-days-not-whole`), and a device
		// drops the time of day a fraction names (`epoch-fraction-on-device`).
		const { context: server } = slot("search-predicate");
		expect(admitted(eq(SEEN_ON, dateCoerce(term(literal(1.5)))), server)).toBe(
			false,
		);
		expect(
			admitted(
				eq(SEEN_ON, dateCoerce(double(term(input(TEXT_INPUT))))),
				server,
			),
		).toBe(false);
		expect(
			admitted(eq(SEEN_AT, datetimeCoerce(term(literal(19000.5)))), server),
		).toBe(true);
		const { context: device } = slot("case-filter");
		expect(
			admitted(eq(SEEN_AT, datetimeCoerce(term(literal(19000.5)))), device),
		).toBe(false);
		expect(
			admitted(eq(SEEN_AT, datetimeCoerce(term(literal(19000)))), device),
		).toBe(true);
	});
});

describe("the choices card adds a value worked out at run time", () => {
	const fixed = multiSelectAny(TAGS, literal("urgent"));
	const withValue = (value: Expression): Expression => ({
		...fixed,
		values: [...fixed.values, value],
	});

	it("constrains a value to one choice wherever a device evaluates the slot", () => {
		for (const carrier of CARRIERS) {
			const { context } = slot(carrier);
			const accepts = multiSelectValueConstraint(context).accepts;
			if (accepts === "any") throw new Error("The constraint is typed.");
			expect(deviceEvaluatesSlot(context), carrier).toBe(
				carrier !== "search-predicate",
			);
			// A search answer is text: the server reads its words, a device
			// would read it as one choice, so the gate admits it only where the
			// constraint admits text.
			expect(
				admitted(withValue(term(input(PICK_INPUT))), context),
				carrier,
			).toBe(accepts.has("text"));
		}
	});

	it("commits the first source the gate admits where only the server reads it", () => {
		const server = slot("search-predicate");
		const offer = addMultiSelectValueOffer(
			fixed,
			{ ...server, userProperties: [] },
			admitter(server.context),
		);
		if (!offer.admitted) throw new Error(offer.reason);
		expect(offer.added).toEqual(term(input(TEXT_INPUT)));
		expect(offer.next).toEqual(withValue(term(input(TEXT_INPUT))));
		expect(admitted(offer.next, server.context)).toBe(true);
	});

	it("offers nothing in a device slot with no single-choice source, with the reason", () => {
		const device = slot("search-case-filter");
		const offer = addMultiSelectValueOffer(
			fixed,
			{ ...device, userProperties: [] },
			admitter(device.context),
		);
		expect(offer).toEqual({
			admitted: false,
			reason: NO_RUNTIME_CHOICE_VALUE_REASON,
		});
	});

	it("offers one choice of the case chosen in an earlier menu in a device slot", () => {
		// Members chooses a household first; its case list filter runs on the
		// device after that choice.
		const base = chosenCaseDoc();
		const doc = {
			...base,
			caseTypes: (base.caseTypes ?? []).map((type) =>
				type.name === "household"
					? {
							...type,
							properties: [
								...type.properties,
								{
									name: "kind",
									label: proseText("Kind"),
									data_type: "single_select" as const,
									options: [{ value: "urgent", label: proseText("Urgent") }],
								},
							],
						}
					: type.name === "member"
						? {
								...type,
								properties: [
									...type.properties,
									{
										name: "tags",
										label: proseText("Tags"),
										data_type: "multi_select" as const,
										options: [{ value: "urgent", label: proseText("Urgent") }],
									},
								],
							}
						: type,
			),
		};
		const context = slotContext(
			doc,
			{ entity: "module", uuid: chosen.members, slot: "case_list_filter" },
			new Map(),
		);
		if (context === undefined) throw new Error("The slot has a context.");
		expect(deviceEvaluatesSlot(context)).toBe(true);
		const value = multiSelectAny(prop("member", "tags"), literal("urgent"));
		const offer = addMultiSelectValueOffer(
			value,
			{ context, knownInputs: [], userProperties: [] },
			admitter(context),
		);
		if (!offer.admitted) throw new Error(offer.reason);
		expect(offer.added).toEqual(
			chosenCaseProperty(chosen.households, "household", "kind"),
		);
		expect(admitted(offer.next, context)).toBe(true);
		// A text property of the same case is refused there, as the
		// constraint says.
		expect(
			admitted(
				{
					...value,
					values: [
						...value.values,
						chosenCaseProperty(chosen.households, "household", "village_name"),
					],
				},
				context,
			),
		).toBe(false);
	});
});

describe("the distance card", () => {
	it("labels all nine of HQ's units in words a person reads", () => {
		expect(Object.keys(DISTANCE_UNIT_LABELS)).toEqual([...DISTANCE_UNITS]);
		expect(Object.values(DISTANCE_UNIT_LABELS)).toEqual([
			"miles",
			"yards",
			"feet",
			"inches",
			"kilometers",
			"meters",
			"centimeters",
			"millimeters",
			"nautical miles",
		]);
	});

	it("commits every unit the menu offers in every slot", () => {
		for (const carrier of CARRIERS) {
			const { context } = slot(carrier);
			for (const unit of DISTANCE_UNITS)
				expect(
					admitted(within(WHERE, term(literal("0 0")), 5, unit), context),
					`${carrier}: ${unit}`,
				).toBe(true);
		}
	});

	it("offers a value for the distance and the unit exactly where the gate admits it", () => {
		for (const carrier of CARRIERS) {
			const search = slot(carrier);
			const fixedValue = within(WHERE, term(literal("0 0")), 5, "miles");
			const toValue = distanceSourceChoices(
				fixedValue,
				search.knownInputs,
				admitter(search.context),
			);
			expect(toValue.distance.next.distance).toEqual(
				double(term(input(TEXT_INPUT))),
			);
			expect(toValue.unit.next.unit).toEqual(term(input(TEXT_INPUT)));
			for (const choice of [toValue.distance, toValue.unit])
				expect(choice.admission.admitted, carrier).toBe(
					admitted(choice.next, search.context),
				);
			expect(toValue.distance.admission.admitted, carrier).toBe(true);
			expect(toValue.unit.admission.admitted, carrier).toBe(true);

			// And back: a value returns to a fixed distance and unit.
			const back = distanceSourceChoices(
				{
					...fixedValue,
					distance: toValue.distance.next.distance,
					unit: toValue.unit.next.unit,
				},
				search.knownInputs,
				admitter(search.context),
			);
			expect(back.distance.next.distance).toBe(1);
			expect(back.unit.next.unit).toBe("miles");
			expect(back.distance.admission.admitted).toBe(true);
			expect(back.unit.admission.admitted).toBe(true);
		}
	});

	it("constrains a distance value to a number and a unit value to text or one choice, as the gate does", () => {
		const { context } = slot("search-predicate");
		const base = within(WHERE, term(literal("0 0")), 5, "miles");
		const text = term(input(TEXT_INPUT));
		const number = double(text);
		const day = dateCoerce(text);
		for (const [value, type] of [
			[text, "text"],
			[number, "decimal"],
			[day, "date"],
		] as const) {
			expect(
				admitted({ ...base, distance: value }, context),
				`distance from ${type}`,
			).toBe(acceptsType(DISTANCE_VALUE_CONSTRAINT, type));
			expect(
				admitted({ ...base, unit: value }, context),
				`unit from ${type}`,
			).toBe(acceptsType(DISTANCE_UNIT_VALUE_CONSTRAINT, type));
		}
	});
});
