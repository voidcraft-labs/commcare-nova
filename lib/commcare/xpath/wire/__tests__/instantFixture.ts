import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { formCasePropertyRead } from "@/lib/commcare/xform/formCaseRead";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { advancedSearchInputDef, proseText } from "@/lib/domain";
import {
	formField,
	matchAll,
	now,
	term,
} from "@/lib/domain/expression/builders";
import {
	type ExpressionContext,
	slotContext,
} from "@/lib/domain/expression/context";
import { formStructure } from "@/lib/domain/expression/formStructure";
import type { Expression } from "@/lib/domain/expression/types";
import { emitCsql } from "../../../csql/emitter";
import { formNodeProjection } from "../../formNodeProjection";
import { toWire, type WireTarget } from "../fromExpression";
import type { WireExpr } from "../tree";

/** How a form value is held on a device, and the field that holds it so:
 * a date-and-time question (a typed `DateTimeData`), a Hidden Value copying
 * a date-and-time case property (text), a date question (`DateData`), a
 * Hidden Value copying a date property (date text), a Hidden Value holding
 * `now()` under its `xsd:string` bind (a `DateData` whose clock is lost), a
 * number question and a Hidden Value with no value of its own (no known type,
 * held as text). */
export type HeldKind =
	| "typed"
	| "text"
	| "date"
	| "date-text"
	| "clock-lost"
	| "int"
	| "unknown";

const FORM = testUuid("instant-form");
const MODULE = testUuid("instant-module");
const PROBE = testUuid("instant-probe");
const SEARCH_INPUT = testUuid("instant-search-input");

function fieldSpec(id: string, kind: HeldKind) {
	const uuid = testUuid(`instant-${id}`);
	switch (kind) {
		case "typed":
			return f({ uuid, id, kind: "datetime" });
		case "date":
			return f({ uuid, id, kind: "date" });
		case "int":
			return f({ uuid, id, kind: "int" });
		case "text":
			return f({
				uuid,
				id,
				kind: "hidden",
				calculate: term({
					kind: "form-case",
					caseType: "visit",
					property: "seen",
				}),
			});
		case "date-text":
			return f({
				uuid,
				id,
				kind: "hidden",
				calculate: term({
					kind: "form-case",
					caseType: "visit",
					property: "day",
				}),
			});
		case "clock-lost":
			return f({ uuid, id, kind: "hidden", calculate: now() });
		case "unknown":
			return f({ uuid, id, kind: "hidden" });
	}
}

export interface InstantFixture {
	readonly doc: BlueprintDoc;
	/** A read of the named form field. */
	field(id: string): Expression;
	/** The form logic context of a Hidden Value's calculate in the form. */
	readonly form: ExpressionContext;
	/** The case list filter's context, a record slot evaluated on a device. */
	readonly record: ExpressionContext;
	/** `types`: the form's context with another supply, such as a search's
	 * results. */
	lowerForm(
		expression: Expression,
		target?: WireTarget,
		types?: ExpressionContext,
	): WireExpr;
	lowerRecord(expression: Expression, target?: WireTarget): WireExpr;
	/** With `search`: an advanced Search field's condition, which only the
	 * server search and the case store read but whose values outside the
	 * server's own a device works out first, and its emitted `_xpath_query`
	 * value. */
	readonly search?: {
		readonly ctx: ExpressionContext;
		lower(expression: Expression): WireExpr;
	};
}

/** One follow-up form on case type `visit` (properties `seen` and `due`,
 * dates and times; `day`, a date; `visits`, a number; `note`, text) holding
 * each named field as its kind. */
export function instantFixture(
	fields: Readonly<Record<string, HeldKind>>,
	options: { readonly search?: boolean } = {},
): InstantFixture {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "visit",
				properties: [
					{ name: "seen", label: proseText("Seen"), data_type: "datetime" },
					{ name: "due", label: proseText("Due"), data_type: "datetime" },
					{ name: "day", label: proseText("Day"), data_type: "date" },
					{ name: "visits", label: proseText("Visits"), data_type: "int" },
					{ name: "note", label: proseText("Note"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				uuid: MODULE,
				name: "Visits",
				caseType: "visit",
				caseListConfig:
					options.search === true
						? {
								...caseListConfig([]),
								searchInputs: [
									advancedSearchInputDef(
										SEARCH_INPUT,
										"when",
										"When",
										"text",
										matchAll(),
									),
								],
							}
						: caseListConfig([]),
				...(options.search === true ? { caseSearchConfig: {} } : {}),
				forms: [
					{
						uuid: FORM,
						name: "Check",
						type: "followup",
						fields: [
							...Object.entries(fields).map(([id, kind]) =>
								fieldSpec(id, kind),
							),
							f({
								uuid: PROBE,
								id: "probe",
								kind: "hidden",
								calculate: term({ kind: "literal", value: "" }),
							}),
						],
					},
				],
			},
		],
	});
	const form = slotContext(
		doc,
		{ entity: "field", uuid: PROBE, slot: "calculate" },
		new Map(),
	);
	const record = slotContext(
		doc,
		{ entity: "module", uuid: MODULE, slot: "case_list_filter" },
		new Map(),
	);
	const search =
		options.search === true
			? slotContext(
					doc,
					{
						entity: "module",
						uuid: MODULE,
						slot: "search_input_predicate",
						member: { searchInputUuid: SEARCH_INPUT },
					},
					new Map(),
				)
			: undefined;
	if (options.search === true && search === undefined)
		throw new Error("The instant fixture's Search field is missing.");
	const structure = formStructure(doc, FORM);
	if (form === undefined || record === undefined || structure === undefined)
		throw new Error("The instant fixture's slots are missing.");
	const projection = formNodeProjection(doc, structure);
	// The follow-up form reads its own `visit` case as the XForm emitter does.
	const formCaseProperty = formCasePropertyRead({
		formType: "followup",
		caseTypeDepths: new Map([["visit", 0]]),
		moduleCaseType: "visit",
	});
	return {
		doc,
		field: (id) => term(formField(testUuid(`instant-${id}`) as Uuid)),
		form,
		record,
		lowerForm: (expression, target = "xform", types = form) =>
			toWire(expression, {
				target,
				types,
				form: projection,
				bindings: { formCaseProperty },
			}),
		lowerRecord: (expression, target = "suite") =>
			toWire(expression, { target, types: record }),
		...(search === undefined
			? {}
			: {
					search: {
						ctx: search,
						lower: (expression: Expression) =>
							emitCsql(expression, { types: search }).wrapper,
					},
				}),
	};
}
