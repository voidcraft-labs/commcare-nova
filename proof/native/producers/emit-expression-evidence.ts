/** Private expression controls for Core and HQ. This family constructs no app. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { testUuid } from "../../../__tests__/helpers/uuid";
import { buildDoc, f } from "../../../lib/__tests__/docHelpers";
import {
	instantFixedClock,
	instantOrderingPairs,
} from "../../../lib/commcare/__tests__/instantOrderingTable";
import { xel } from "../../../lib/commcare/elementBuilders";
import { requireExpressionContext } from "../../../lib/commcare/expressionContext";
import { serializeXml } from "../../../lib/commcare/serializeXml";
import { w } from "../../../lib/commcare/xpath/wire/builders";
import { toWire } from "../../../lib/commcare/xpath/wire/fromExpression";
import { InstanceSink } from "../../../lib/commcare/xpath/wire/instances";
import { serializeWire } from "../../../lib/commcare/xpath/wire/serialize";
import type { Expression } from "../../../lib/domain/expression";
import { concat, literal, term } from "../../../lib/domain/expression/builders";
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
const pairs = instantOrderingPairs().map((pair) => ({
	...pair,
	left: { ...pair.left, node: "left" },
	right: { ...pair.right, node: "right" },
}));
writeFileSync(
	resolve(output, "orderings.json"),
	`${JSON.stringify({
		schemaVersion: 1,
		fixedClock: instantFixedClock,
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
	`Produced ${pairs.length} private expression controls and ${CORE_DATE_PARITY.rows.length} date parity rows.`,
);
