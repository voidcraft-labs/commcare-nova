/** Private expression controls for Core and HQ. This family constructs no app. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { testUuid } from "../../../__tests__/helpers/uuid";
import { buildDoc, f } from "../../../lib/__tests__/docHelpers";
import {
	type InstantOperand,
	type InstantOperator,
	instantFixedClock,
	instantOrderingPairs,
} from "../../../lib/commcare/__tests__/instantOrderingTable";
import { xel } from "../../../lib/commcare/elementBuilders";
import { requireExpressionContext } from "../../../lib/commcare/expressionContext";
import { serializeXml } from "../../../lib/commcare/serializeXml";
import { formNodeProjection } from "../../../lib/commcare/xpath/formNodeProjection";
import { w } from "../../../lib/commcare/xpath/wire/builders";
import { toWire } from "../../../lib/commcare/xpath/wire/fromExpression";
import { InstanceSink } from "../../../lib/commcare/xpath/wire/instances";
import { serializeWire } from "../../../lib/commcare/xpath/wire/serialize";
import type { Uuid } from "../../../lib/domain";
import { proseText } from "../../../lib/domain";
import type { Expression } from "../../../lib/domain/expression";
import {
	concat,
	datetimeCoerce,
	eq,
	formField,
	gt,
	gte,
	literal,
	lt,
	lte,
	neq,
	now,
	term,
} from "../../../lib/domain/expression/builders";
import { formStructure } from "../../../lib/domain/expression/formStructure";
import { checkExpression } from "../../../lib/domain/expression/typeChecker";
import {
	CORE_DATE_PARITY,
	CORE_DATE_PARITY_ZONES,
} from "../../../lib/preview/xpath/__tests__/fixtures/coreDateParity";

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: node --import tsx proof/native/producers/emit-expression-evidence.ts OUTPUT_DIRECTORY",
	);
mkdirSync(output, { recursive: true });

/** How a device holds an operand, which is all its lowered text depends on:
 * the values live in the instance, never in the text. InstantOrderingRuntimeTest
 * derives the same class from the same row and checks it against the key. */
type OperandClass =
	| "datetime"
	| "now"
	| "text"
	| "date"
	| "date-text"
	| "coerced-date"
	| "coerced-date-text";
function operandClass(operand: InstantOperand): OperandClass {
	switch (operand.held) {
		case "datetime":
		case "now":
			return operand.held;
		case "text":
		case "core-text":
		case "malformed":
			return "text";
		case "date":
		case "date-text":
			return operand.datetimeCoerce ? `coerced-${operand.held}` : operand.held;
	}
}

const LOWERED_FORM = testUuid("native-instant-form");
const LOWERED_OPERATION = testUuid("native-instant-operation");
const comparisons = {
	"<": lt,
	"<=": lte,
	">": gt,
	">=": gte,
	"=": eq,
	"!=": neq,
} as const satisfies Record<InstantOperator, unknown>;

/** The field that holds one side, named `left` or `right` so its read prints
 * `/data/left` or `/data/right`, the nodes the Core class builds: a
 * date-and-time question (a typed `DateTimeData`), a Hidden Value copying a
 * date-and-time case property (text), a date question (`DateData`) and a
 * Hidden Value copying a date property (date text). `now()` has none. */
function sideField(id: "left" | "right", kind: OperandClass) {
	const uuid = testUuid(`native-instant-${id}`);
	switch (kind) {
		case "now":
			return [];
		case "datetime":
			return [f({ uuid, id, kind: "datetime" })];
		case "date":
		case "coerced-date":
			return [f({ uuid, id, kind: "date" })];
		case "text":
		case "date-text":
		case "coerced-date-text":
			return [
				f({
					uuid,
					id,
					kind: "hidden",
					calculate: term({
						kind: "form-case",
						caseType: "visit",
						property: kind === "text" ? "seen" : "day",
					}),
				}),
			];
	}
}
function sideRead(id: "left" | "right", kind: OperandClass): Expression {
	if (kind === "now") return now();
	const read = term(formField(testUuid(`native-instant-${id}`) as Uuid));
	return kind.startsWith("coerced-") ? datetimeCoerce(read) : read;
}

/** One comparison of two classes, printed from the slot a device evaluates it
 * in: a form's relevant condition, or, for a coerced date (which form logic
 * has no spelling of), a case operation's condition, a record slot whose
 * target is the XForm. Each is typed by the slot's own context, never
 * compiled into an app. */
function loweredText(
	left: OperandClass,
	operator: InstantOperator,
	right: OperandClass,
): string {
	const probe = testUuid("native-instant-probe");
	const doc = buildDoc({
		caseTypes: [
			{
				name: "visit",
				properties: [
					{ name: "seen", label: proseText("Seen"), data_type: "datetime" },
					{ name: "day", label: proseText("Day"), data_type: "date" },
				],
			},
		],
		modules: [
			{
				name: "Visits",
				caseType: "visit",
				forms: [
					{
						uuid: LOWERED_FORM,
						name: "Check",
						type: "followup",
						fields: [
							...sideField("left", left),
							...sideField("right", right),
							f({ uuid: probe, id: "probe", kind: "text" }),
						],
					},
				],
			},
		],
	});
	const form = doc.forms[LOWERED_FORM as Uuid];
	if (form === undefined) throw new Error("The lowering form is missing.");
	form.caseOperations = [
		...(form.caseOperations ?? []),
		{
			uuid: LOWERED_OPERATION as Uuid,
			id: "native_instant_update",
			action: "update",
			caseType: "visit",
			target: { kind: "session" },
		},
	];
	const coerced = [left, right].some((kind) => kind.startsWith("coerced-"));
	const types = requireExpressionContext(
		doc,
		coerced
			? {
					entity: "form",
					uuid: LOWERED_FORM,
					slot: "case_operation_condition",
					member: { operationUuid: LOWERED_OPERATION },
				}
			: { entity: "field", uuid: probe, slot: "relevant" },
	);
	const structure = formStructure(doc, LOWERED_FORM as Uuid);
	if (structure === undefined) throw new Error("The lowering form is missing.");
	const comparison = comparisons[operator](
		sideRead("left", left),
		sideRead("right", right),
	);
	// The lane holds what Nova emits for an admitted document: a shape the
	// checker refuses in its slot is no evidence of the lowering.
	const refused = checkExpression(comparison, types).errors;
	if (refused.length > 0)
		throw new Error(
			`The lowered comparison ${left} ${operator} ${right} is refused in its slot (${refused
				.map(
					(error) =>
						`${error.code}${error.reason === undefined ? "" : `:${error.reason}`}: ${error.message}`,
				)
				.join(
					"; ",
				)}), so a device never receives it. Remove the pair from the instant table or give it a slot that admits it.`,
		);
	return serializeWire(
		toWire(comparison, {
			target: "xform",
			types,
			form: formNodeProjection(doc, structure),
		}),
		{ target: "xform", constraint: false },
	).text;
}

const lowered: Record<string, string> = {};
const pairs = instantOrderingPairs().map((pair) => {
	const key = `${operandClass(pair.left)}|${pair.operator}|${operandClass(pair.right)}`;
	lowered[key] ??= loweredText(
		operandClass(pair.left),
		pair.operator,
		operandClass(pair.right),
	);
	return {
		...pair,
		key,
		left: { ...pair.left, node: "left" },
		right: { ...pair.right, node: "right" },
	};
});
writeFileSync(
	resolve(output, "orderings.json"),
	`${JSON.stringify({
		schemaVersion: 2,
		fixedClock: instantFixedClock,
		lowered,
		pairs,
	})}\n`,
);

// CoreDateParityRuntimeTest holds Core to the table Preview's evaluator is
// held to in Vitest, one column per device zone.
writeFileSync(
	resolve(output, "core-date-parity.json"),
	`${JSON.stringify({ ...CORE_DATE_PARITY, zones: CORE_DATE_PARITY_ZONES })}\n`,
);

// HQ replaces shortcuts without parsing literals and scans for instance calls
// after HTML decoding. These are values, never authored XPath source. The final
// dot also exposes a quote left open by HQ's backslash-aware interpolation.
const interpolationValues = [
	["case", "#case"],
	["parent", "#parent"],
	["host", "#host"],
	["worker", "#user"],
	["session", "#session/x"],
	["unused-fixture-token", "$fixture_value"],
	["trailing-backslash", "value\\"],
	["trailing-three-backslashes", "value\\\\\\"],
	["trailing-even-backslashes", "value\\\\"],
	["backslash-before-quote", 'value\\".next'],
	["backslash-before-token", "value\\#case"],
	["both-quotes", 'it\'s "quoted"'],
	["instance-single", "instance('literal')"],
	["instance-double", 'instance("literal")'],
	["instance-whitespace", "instance(\u0085'literal'\u0085)"],
	["entity-quotes", "instance(&apos;literal&apos;)"],
	["entity-letters", "&#105;nstance('literal')"],
	["entity-parentheses", "instance&#40;'literal'&#41;"],
	["entity-whitespace", "instance(&Tab;'literal'&Tab;)"],
	["entity-numeric-whitespace", "instance(&#x85;'literal'&#x85;)"],
	["entity-no-semicolon", "&#105nstance(&#39literal&#39)"],
	["entity-dropped-control", "inst&#1;ance('literal')"],
	["entity-dropped-delete", "inst&#x7f;ance('literal')"],
	["entity-dropped-vertical-tab", "inst&#11;ance('literal')"],
] as const;
/** Each scalar probe is emitted from a real hidden field's calculate slot. */
function contextFor(expression: Expression) {
	const uuid = testUuid("native-interpolation-value");
	const doc = buildDoc({
		modules: [
			{
				name: "Values",
				forms: [
					{
						name: "Values",
						type: "survey",
						fields: [
							f({ uuid, id: "value", kind: "hidden", calculate: expression }),
						],
					},
				],
			},
		],
	});
	return requireExpressionContext(doc, {
		entity: "field",
		uuid,
		slot: "calculate",
	});
}
const interpolation = interpolationValues.flatMap(([id, value]) => {
	const expression = concat(term(literal(value)), term(literal(".")));
	return (["none", "case", "no-case", "no-dots"] as const).map((mode) => {
		const text = serializeWire(
			toWire(expression, { target: "hq-json", types: contextFor(expression) }),
			{ target: "hq-json", interpolation: mode },
		).text;
		return { id, mode, value: `${value}.`, text };
	});
});
const xforms = interpolationValues.map(([id, value]) => {
	const expression = concat(term(literal(value)), term(literal(".")));
	const wire = toWire(expression, {
		target: "xform",
		types: contextFor(expression),
	});
	const text = serializeWire(wire, { target: "xform", constraint: false }).text;
	return {
		id,
		value: `${value}.`,
		text,
		xml: serializeXml(
			xel(
				"bind",
				{ xpath: { calculate: wire } },
				{
					mode: { target: "xform", constraint: false },
					instances: new InstanceSink(),
				},
			),
		),
	};
});
// Image mapping keys run only HQ's dot interpolator. Both unquoted dots
// must become the supplied property, including the one after the literal.
const enumKeys = [...interpolationValues, ["literal-dot", "."] as const].map(
	([id, value]) => ({
		id,
		value,
		text: serializeWire(
			w.call("concat", [w.context(), w.str(value), w.context()]),
			{ target: "hq-json", interpolation: "enum-key" },
		).text,
	}),
);
writeFileSync(
	resolve(output, "interpolation.json"),
	`${JSON.stringify({ schemaVersion: 1, interpolation, xforms, enumKeys })}\n`,
);
console.log(
	`Produced ${pairs.length} private expression controls over ${Object.keys(lowered).length} lowered comparisons and ${CORE_DATE_PARITY.rows.length} date parity rows.`,
);
