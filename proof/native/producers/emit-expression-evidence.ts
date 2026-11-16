/** Private expression controls for Core and HQ. This family constructs no app. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import { testUuid } from "../../../__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "../../../lib/__tests__/docHelpers";
import {
	type InstantOperand,
	type InstantOperator,
	instantFixedClock,
	instantOrderingPairs,
} from "../../../lib/commcare/__tests__/instantOrderingTable";
import {
	ROW_DEFAULT_ROWS,
	ROW_PREDICATE_ROWS,
	rowDefaultDoc,
	rowPredicateDoc,
} from "../../../lib/commcare/__tests__/rowPredicateFixture";
import {
	countGuarded,
	sessionContextReadsDoc,
	WINDOW_WIDTH_COLUMN,
	WINDOW_WIDTH_GATE_NODES,
	WINDOW_WIDTH_MODULE,
	WINDOW_WIDTH_PATH,
	windowWidthColumnDoc,
	windowWidthGateXForm,
} from "../../../lib/commcare/__tests__/sessionContextFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { xel } from "../../../lib/commcare/elementBuilders";
import { expandDoc } from "../../../lib/commcare/expander";
import {
	moduleExpressionContexts,
	requireExpressionContext,
} from "../../../lib/commcare/expressionContext";
import { caseListStepDatumId } from "../../../lib/commcare/formLinkProjection";
import { projectCaseListFilter } from "../../../lib/commcare/hqJson/caseList";
import { hqXPathText } from "../../../lib/commcare/hqJson/xpath";
import {
	DOT_VECTORS,
	INTERPOLATION_VECTORS,
} from "../../../lib/commcare/reader/__tests__/interpolationVectors";
import { SPELLING_VECTORS } from "../../../lib/commcare/reader/expressions/__tests__/spellingVectors";
import {
	dotInterpolate,
	type HqInterpolationSlot,
	hqInterpolationSlot,
	interpolateHqXPath,
} from "../../../lib/commcare/reader/hqInterpolation";
import { serializeXml } from "../../../lib/commcare/serializeXml";
import { CASE_LIST_SEARCH_TEXT_DATA_NAME } from "../../../lib/commcare/sessionContext";
import { emitNodesetFilter } from "../../../lib/commcare/suite/case-list/nodesetFilter";
import { searchPromptWire } from "../../../lib/commcare/suite/case-search/searchPrompts";
import {
	emitFormDisplayConditionForHq,
	emitFormDisplayConditionForSuite,
	emitModuleDisplayCondition,
} from "../../../lib/commcare/suite/displayConditions";
import { runValidation } from "../../../lib/commcare/validator/runner";
import { formNodeProjection } from "../../../lib/commcare/xpath/formNodeProjection";
import { w } from "../../../lib/commcare/xpath/wire/builders";
import { toWire } from "../../../lib/commcare/xpath/wire/fromExpression";
import { InstanceSink } from "../../../lib/commcare/xpath/wire/instances";
import { serializeWire } from "../../../lib/commcare/xpath/wire/serialize";
import type { WireExpr } from "../../../lib/commcare/xpath/wire/tree";
import { datetimeSplitOriginal } from "../../../lib/doc/__tests__/datetimeSplitFixture";
import { mutationCommitVerdict } from "../../../lib/doc/commitVerdicts";
import { planDatetimeSplits } from "../../../lib/doc/datetimeSplit";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../../../lib/doc/lookupReferences";
import type { BlueprintDoc, Uuid } from "../../../lib/domain";
import {
	fieldCaseWriteViews,
	proseText,
	simpleSearchInputDef,
} from "../../../lib/domain";
import type { Expression } from "../../../lib/domain/expression";
import {
	ancestorPath,
	and,
	concat,
	datetimeCoerce,
	eq,
	formField,
	gt,
	gte,
	input,
	isBlank,
	literal,
	lt,
	lte,
	matchesPattern,
	neq,
	now,
	prop,
	relationStep,
	sessionContext,
	term,
} from "../../../lib/domain/expression/builders";
import { formStructure } from "../../../lib/domain/expression/formStructure";
import { checkExpression } from "../../../lib/domain/expression/typeChecker";
import {
	LIST_FILTER_FUZZY_VECTORS,
	LIST_FILTER_NORMALIZE_VECTORS,
} from "../../../lib/preview/__tests__/fixtures/listFilterMatch";
import {
	PROSE_VALUE_ANSWERS,
	PROSE_VALUE_MESSAGES,
	PROSE_VALUE_VECTORS,
	proseValueVectorDoc,
} from "../../../lib/preview/engine/__tests__/proseValue.vectors";
import {
	CORE_DATE_PARITY,
	CORE_DATE_PARITY_ZONES,
} from "../../../lib/preview/xpath/__tests__/fixtures/coreDateParity";
import { NATIVE_RUNTIME_TARGET } from "./runtimeTarget";

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: node --conditions=react-server --import tsx proof/native/producers/emit-expression-evidence.ts OUTPUT_DIRECTORY",
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
			form: formNodeProjection(doc, structure, { surface: "wire" }),
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

// DatetimeSplitRuntimeTest runs the date-and-time split's forms in Core: the
// shared original (`datetimeSplitFixture.ts`) with Nova's planner's splits
// admitted by Nova's commit gate, compiled into a local archive.
{
	const original = datetimeSplitOriginal();
	const plan = planDatetimeSplits(original);
	if (!plan.ok)
		throw new Error(
			`Nova's planner refused to split the shared original: ${plan.message}`,
		);
	const verdict = mutationCommitVerdict(
		original,
		plan.mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!verdict.ok)
		throw new Error(
			`Nova's commit gate refused the split of the shared original (${verdict.findings
				.map((finding) => `${finding.code}: ${finding.message}`)
				.join("; ")}), so no device would receive it.`,
		);
	const doc = verdict.nextDoc;
	const archive = new AdmZip(
		compileCcz(expandDoc(doc), doc.appName, doc, {
			runtimeTarget: NATIVE_RUNTIME_TARGET,
		}),
	);
	const directory = resolve(output, "datetime-split");
	mkdirSync(directory, { recursive: true });
	const forms = { book: [0, 0], check: [0, 1], plan: [1, 0] } as const;
	for (const [name, [module, form]] of Object.entries(forms))
		writeFileSync(
			resolve(directory, `${name}.xml`),
			archive.readAsText(`modules-${module}/forms-${form}.xml`),
		);
	const paths = (fieldUuid: Uuid) => {
		const split = plan.splits.find((entry) => entry.fieldUuid === fieldUuid);
		const field = doc.fields[fieldUuid];
		if (split === undefined || field === undefined)
			throw new Error("The shared original's split is missing a question.");
		return {
			date: `/data/${split.dateId}`,
			time: `/data/${split.timeId}`,
			joined: `/data/${field.id}`,
		};
	};
	// The writer is the one split question that writes a case property; the
	// others only read. Its untyped case value must be in the compiled form,
	// so a renamed node fails here rather than in the Core run.
	const writers = plan.splits.filter(
		(split) => fieldCaseWriteViews(doc, split.fieldUuid).length > 0,
	);
	if (writers.length !== 1 || writers[0] === undefined)
		throw new Error(
			`The shared original's split should hold one question that writes a case property, and it holds ${writers.length}.`,
		);
	const writer = paths(writers[0].fieldUuid);
	const readers = plan.splits
		.filter((split) => split !== writers[0])
		.map((split) => paths(split.fieldUuid));
	const caseValue = `/data/nova_datetime_${writer.joined.slice("/data/".length)}`;
	if (
		!archive
			.readAsText(`modules-${forms.check[0]}/forms-${forms.check[1]}.xml`)
			.includes(`nodeset="${caseValue}"`)
	)
		throw new Error(
			`The check form holds no bind for the split question's case value ${caseValue}, so the Core run would read a missing node.`,
		);
	writeFileSync(
		resolve(output, "datetime-split.json"),
		`${JSON.stringify({
			schemaVersion: 1,
			writer: {
				form: "/expression/datetime-split/check.xml",
				...writer,
				caseValue,
			},
			readers: readers.map((reader) => ({
				form: "/expression/datetime-split/plan.xml",
				...reader,
			})),
			// Entries away from every transition: the answered wall clock reads
			// back as itself in every zone.
			entries: [
				{ date: "2026-03-04", time: "10:30:00" },
				{ date: "2026-07-15", time: "23:45:00" },
				{ date: "2026-01-01", time: "00:00:00" },
			],
			// New York's spring-forward gap and its fall-back repeated hour.
			transitions: [
				{ id: "spring-forward-gap", date: "2026-03-08", time: "02:30:00" },
				{ id: "fall-back-repeated-hour", date: "2026-11-01", time: "01:30:00" },
			],
			// The case the writer's form opens, whose value fills both questions.
			preload: {
				caseDatum: "case_id",
				caseId: "native-visit",
				caseType: "visit",
				property: "seen_at",
				value: "2026-03-04T10:30:00.000000Z",
				instant: "2026-03-04T10:30:00Z",
			},
		})}\n`,
	);
}

/** A document Nova's commit gate admits, or a refusal naming its findings:
 * the lane holds what Nova emits for an admitted document. */
function admitted(name: string, doc: BlueprintDoc): BlueprintDoc {
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length > 0)
		throw new Error(
			`Nova's validator refuses the ${name} (${findings
				.map((finding) => `${finding.code}: ${finding.message}`)
				.join("; ")}), so no device would receive it.`,
		);
	return doc;
}
/** One form of an admitted document, as its local archive holds it. */
function compiledForm(doc: BlueprintDoc, module: number, form: number) {
	return new AdmZip(
		compileCcz(expandDoc(doc), doc.appName, doc, {
			runtimeTarget: NATIVE_RUNTIME_TARGET,
		}),
	).readAsText(`modules-${module}/forms-${form}.xml`);
}

// SessionContextRuntimeTest runs the session context reads in Core. The
// window width gate's form is a control written by hand, since Nova never
// emits a bare width read in a form: Core decides whether one throws when a
// later request carries no width. The guarded reads are Nova's own prints:
// the clock drift, the app language and the case list's search text in a
// form, and the window width in a case list column, a slot CommCare
// evaluates while the list loads.
{
	const directory = resolve(output, "session-context");
	mkdirSync(directory, { recursive: true });
	writeFileSync(resolve(directory, "window-width.xml"), windowWidthGateXForm());
	const reads = admitted("session context reads", sessionContextReadsDoc());
	writeFileSync(resolve(directory, "reads.xml"), compiledForm(reads, 0, 0));
	const columns = admitted("window width column", windowWidthColumnDoc());
	const column = columns.modules[
		WINDOW_WIDTH_MODULE
	]?.caseListConfig?.columns.find(
		(entry) => entry.uuid === WINDOW_WIDTH_COLUMN,
	);
	if (column?.kind !== "calculated")
		throw new Error("The window width column is missing.");
	const windowWidthField = serializeWire(
		toWire(column.expression, {
			target: "suite",
			types: requireExpressionContext(columns, {
				entity: "module",
				uuid: WINDOW_WIDTH_MODULE,
				slot: "case_list_column_expression",
				member: { columnUuid: WINDOW_WIDTH_COLUMN },
			}),
		}),
		{ target: "suite" },
	).text;
	// The gate's guarded calculate is the guard Nova prints, so the gate runs
	// the read Nova ships.
	if (windowWidthField !== countGuarded(WINDOW_WIDTH_PATH))
		throw new Error(
			`Nova prints the window width ${windowWidthField}, which is not the gate form's guarded read ${countGuarded(WINDOW_WIDTH_PATH)}.`,
		);
	writeFileSync(
		resolve(output, "session-context.json"),
		`${JSON.stringify({
			schemaVersion: 1,
			windowWidthGate: {
				form: "/expression/session-context/window-width.xml",
				...WINDOW_WIDTH_GATE_NODES,
				width: "1024",
			},
			reads: {
				form: "/expression/session-context/reads.xml",
				drift: "/data/drift",
				applanguage: "/data/language",
				searched: "/data/searched",
				caseDatum: "case_id",
				caseId: "native-patient",
				query: "Ama",
				searchTextNodes: `instance('commcaresession')/session/data/${CASE_LIST_SEARCH_TEXT_DATA_NAME}`,
			},
			windowWidthField,
		})}\n`,
	);
}

// RowPredicateCurrentRuntimeTest runs a repeat's form reads inside row
// predicates in Core, under the three ways Core evaluates a predicate; the
// class makes the bare `/data/visits/kind` print, its retained control, from
// the same bytes.
{
	const directory = resolve(output, "row-predicates");
	mkdirSync(directory, { recursive: true });
	const doc = admitted("row predicate form", rowPredicateDoc());
	const form = compiledForm(doc, 0, 0);
	for (const read of ["indexed", "scanned", "placed"])
		if (!form.includes(`nodeset="/data/visits/${read}"`))
			throw new Error(`The row predicate form holds no ${read} count.`);
	if (!form.includes("current()/../kind"))
		throw new Error(
			"The row predicate form reads the entry's kind without current(), so it is no evidence of the print.",
		);
	writeFileSync(resolve(directory, "rounds.xml"), form);
	writeFileSync(
		resolve(output, "row-predicates.json"),
		`${JSON.stringify({
			schemaVersion: 1,
			form: "/expression/row-predicates/rounds.xml",
			repeat: "/data/visits",
			kind: "kind",
			current: "current()/../kind",
			bare: "/data/visits/kind",
			...ROW_PREDICATE_ROWS,
		})}\n`,
	);
}

// RowPredicateCurrentRuntimeTest's controls of a starting value's two
// spellings: a direct read of another question when the form opens and when
// a repeat entry is made, which the absolute spelling answers alike, and a
// read of the places filtered by another question of the entry, which only
// `current()` answers per entry. The class makes the absolute spellings from
// the same bytes, and writes the entry's number as its position: Nova's count
// of the repeat inside an entry counts that entry alone, as does a count of
// the repeat's absolute path, which Core contextualizes against the entry
// (`TreeReference.contextualize`).
{
	const doc = admitted("starting values form", rowDefaultDoc());
	const form = compiledForm(doc, 0, 0);
	const reads = {
		early: "current()/../seed",
		copy: "current()/../../seed",
		entryCount: "count(current()/..)",
		named: "current()/../entry",
	};
	for (const [name, read] of Object.entries(reads))
		if (!form.includes(read))
			throw new Error(
				`The starting values form reads ${name} without ${read}, so it is no evidence of the print.`,
			);
	if (!form.includes('event="jr-insert"'))
		throw new Error(
			"The starting values form sets no value when an entry is made, so it is no evidence of a repeat's starting values.",
		);
	writeFileSync(resolve(output, "row-predicates", "starts.xml"), form);
	writeFileSync(
		resolve(output, "row-defaults.json"),
		`${JSON.stringify({
			schemaVersion: 1,
			form: "/expression/row-predicates/starts.xml",
			repeat: "/data/rounds",
			seedReads: [
				{ current: reads.copy, absolute: "/data/seed" },
				{ current: reads.early, absolute: "/data/seed" },
			],
			// Core's position() of a node is its zero-based multiplicity
			// (`XPathPositionFunc.position`, `TreeReference.getMultLast`).
			entryCount: {
				nova: reads.entryCount,
				written: "position(current()/..) + 1",
			},
			named: { current: reads.named, absolute: "/data/rounds/entry" },
			...ROW_DEFAULT_ROWS,
		})}\n`,
	);
}

// RepeatCountRuntimeTest counts rows in Core from the three whole-number
// counts Nova admits beside an int question: a Hidden
// Value calculating an integer and an integer single select, each named
// directly by `jr:count`, and `int(...)` over a decimal, which keeps its
// `nova_count_` node. The form's `half` is the same decimal unwrapped, which
// the class writes into that node to rebuild the fractional count Nova wrote
// before (its retained control).
{
	const directory = resolve(output, "repeat-counts");
	mkdirSync(directory, { recursive: true });
	const counted = (id: string, count: string) =>
		f({
			kind: "repeat",
			id,
			label: proseText(id),
			repeat_mode: "count_bound",
			repeat_count: count,
			children: [f({ kind: "text", id: "note", label: proseText("Note") })],
		});
	const doc = admitted(
		"repeat count form",
		buildDoc({
			appName: "Repeat counts",
			modules: [
				{
					name: "Counts",
					forms: [
						{
							name: "Counts",
							type: "survey",
							fields: [
								f({ kind: "int", id: "n", label: proseText("How many") }),
								f({
									kind: "decimal",
									id: "weight",
									label: proseText("Weight"),
								}),
								f({
									kind: "single_select",
									id: "pick",
									label: proseText("Pick"),
									options: [
										{ value: "1", label: "One" },
										{ value: "2", label: "Two" },
										{ value: "3", label: "Three" },
									],
								}),
								f({ kind: "hidden", id: "planned", calculate: "#form/n + 1" }),
								f({
									kind: "hidden",
									id: "half",
									calculate: "#form/weight div 2",
								}),
								counted("by_hidden", "#form/planned"),
								counted("by_int", "int(#form/weight div 2)"),
								counted("by_select", "#form/pick"),
							],
						},
					],
				},
			],
		}),
	);
	const form = compiledForm(doc, 0, 0);
	// The shapes the class reads: two direct counts, one carrier, and the
	// decimal it rebuilds the control from.
	for (const shape of [
		'jr:count="/data/planned"',
		'jr:count="/data/pick"',
		'jr:count="/data/nova_count_by_int"',
		'nodeset="/data/nova_count_by_int"',
		'nodeset="/data/half"',
	])
		if (!form.includes(shape))
			throw new Error(
				`The repeat count form holds no ${shape}, so Nova no longer writes the count the Core run reads.`,
			);
	writeFileSync(resolve(directory, "counts.xml"), form);
}

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
// The reader of CommCare HQ's apps ports HQ's interpolation
// (lib/commcare/reader/hqInterpolation.ts). test_hq_interpolation.py runs HQ's
// own interpolate_xpath and dot_interpolate over the port's vectors and
// requires the port's answer for each. For every slot HQ interpolates, it runs
// HQ's helper over Nova's HQ JSON print of an expression that reads what the
// slot may read (the case's property in a form's display condition, and its
// parent's too in the case list filter, the worker's session in a display
// condition with no case, the search's answers in a search field's tests), with the case path the reader gives that slot, and requires
// the tree of the answer to be the tree of Nova's suite print of it. The
// document is one Nova admits, so a refused shape fails here by name.
{
	const ids = {
		patients: testUuid("reader-interpolation-patients"),
		visit: testUuid("reader-interpolation-visit"),
		notes: testUuid("reader-interpolation-notes"),
		note: testUuid("reader-interpolation-note"),
		name: testUuid("reader-interpolation-name"),
		check: testUuid("reader-interpolation-check"),
	};
	// A read of the listed case's parent's village, which HQ's `#parent/village`
	// stands for.
	const parentVillage = eq(
		term(
			prop(
				"patient",
				"village",
				ancestorPath(relationStep("parent", "household")),
			),
		),
		term(literal("north")),
	);
	const activeStatus = eq(
		term(prop("patient", "status_code")),
		term(literal("active")),
	);
	const doc = admitted(
		"reader interpolation slots",
		buildDoc({
			caseTypes: [
				{
					name: "household",
					properties: [{ name: "village", label: proseText("Village") }],
				},
				{
					name: "patient",
					parent_type: "household",
					properties: [{ name: "status_code", label: proseText("Status") }],
				},
			],
			modules: [
				{
					uuid: "reader-interpolation-patients",
					name: "Patients",
					caseType: "patient",
					displayCondition: eq(
						term(sessionContext("username")),
						term(literal("lead")),
					),
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						filter: and(activeStatus, parentVillage),
						searchInputs: [
							simpleSearchInputDef(
								ids.name,
								"first_name",
								"Name",
								"text",
								"case_name",
								{ required: { message: "Add a name" } },
							),
							simpleSearchInputDef(
								ids.check,
								"name_check",
								"Name check",
								"text",
								"case_name",
								{
									required: {
										when: isBlank(input(ids.name)),
										message: "Add either name",
									},
									validation: {
										rule: matchesPattern(input(ids.check), "^[A-Z].*$"),
										message: "Start the name with a capital letter",
									},
								},
							),
						],
					},
					caseSearchConfig: {},
					forms: [
						{
							uuid: "reader-interpolation-visit",
							name: "Visit",
							type: "followup",
							// A form's display condition reads the chosen case's own
							// properties alone: Nova refuses a related case there
							// (FORM_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE).
							displayCondition: activeStatus,
							fields: [
								f({ kind: "text", id: "remark", label: proseText("Remark") }),
							],
						},
					],
				},
				{
					uuid: "reader-interpolation-notes",
					name: "Notes",
					forms: [
						{
							uuid: "reader-interpolation-note",
							name: "Note",
							type: "survey",
							displayCondition: eq(
								term(sessionContext("username")),
								term(literal("lead")),
							),
							fields: [
								f({ kind: "text", id: "remark", label: proseText("Remark") }),
							],
						},
					],
				},
			],
		}),
	);
	const menu = doc.modules[ids.patients];
	const form = doc.forms[ids.visit];
	const note = doc.forms[ids.note];
	const filter = menu?.caseListConfig?.filter;
	if (
		menu === undefined ||
		form === undefined ||
		note === undefined ||
		filter === undefined
	)
		throw new Error("The reader interpolation document lost its menu.");
	const expressions = moduleExpressionContexts(doc, ids.patients);
	const suite = (expression: WireExpr | undefined): string => {
		if (expression === undefined)
			throw new Error("A reader interpolation slot printed nothing.");
		return serializeWire(expression, { target: "suite" }).text;
	};
	const slotOf = (
		ref: Parameters<typeof hqInterpolationSlot>[1],
		mode: Parameters<typeof hqInterpolationSlot>[2],
	): HqInterpolationSlot => {
		const slot = hqInterpolationSlot(doc, ref, mode);
		if (slot === undefined)
			throw new Error(`The reader gives the ${ref.slot} slot no case path.`);
		return slot;
	};
	const row = (
		name: string,
		mode: Parameters<typeof hqInterpolationSlot>[2],
		slot: HqInterpolationSlot,
		hq: string,
		local: string,
	) => ({
		slot: name,
		mode,
		caseXPath: slot.caseXPath ?? null,
		interpolateDots: slot.interpolateDots,
		hq,
		suite: local,
	});
	const hqFilter = projectCaseListFilter(
		filter,
		undefined,
		expressions,
		undefined,
		caseListStepDatumId(doc, ids.patients, "chainId"),
	);
	if (hqFilter === null)
		throw new Error("The reader interpolation filter printed nothing.");
	const formTypes = requireExpressionContext(doc, {
		entity: "form",
		uuid: ids.visit,
		slot: "form_display_condition",
	});
	const formHq = emitFormDisplayConditionForHq(
		form,
		formTypes,
		undefined,
		"case_id",
	);
	const noteTypes = requireExpressionContext(doc, {
		entity: "form",
		uuid: ids.note,
		slot: "form_display_condition",
	});
	const noteHq = emitFormDisplayConditionForHq(note, noteTypes);
	const moduleTree = emitModuleDisplayCondition(
		menu,
		expressions({ slot: "module_display_condition" }),
	);
	if (formHq === undefined || noteHq === undefined || moduleTree === undefined)
		throw new Error(
			"A reader interpolation display condition printed nothing.",
		);
	const slots = [
		row(
			"case_details.short.filter",
			"case",
			slotOf(
				{ entity: "module", uuid: ids.patients, slot: "case_list_filter" },
				"case",
			),
			hqXPathText(hqFilter),
			suite(
				emitNodesetFilter(filter, expressions({ slot: "case_list_filter" })),
			),
		),
		row(
			"form_filter",
			"case",
			slotOf(
				{ entity: "form", uuid: ids.visit, slot: "form_display_condition" },
				"case",
			),
			serializeWire(formHq, { target: "hq-json", interpolation: "case" }).text,
			suite(
				emitFormDisplayConditionForSuite(form, formTypes, undefined, "case_id"),
			),
		),
		row(
			"form_filter",
			"no-case",
			slotOf(
				{ entity: "form", uuid: ids.note, slot: "form_display_condition" },
				"no-case",
			),
			serializeWire(noteHq, { target: "hq-json", interpolation: "no-case" })
				.text,
			suite(emitFormDisplayConditionForSuite(note, noteTypes)),
		),
		row(
			"module_filter",
			"no-case",
			slotOf(
				{
					entity: "module",
					uuid: ids.patients,
					slot: "module_display_condition",
				},
				"no-case",
			),
			serializeWire(moduleTree, { target: "hq-json", interpolation: "no-case" })
				.text,
			suite(moduleTree),
		),
	];
	for (const searchInput of menu.caseListConfig?.searchInputs ?? []) {
		const wire = searchPromptWire(
			searchInput,
			undefined,
			expressions,
			undefined,
			"search-input:results",
		);
		const required = wire.required?.test;
		if (required !== undefined)
			slots.push(
				row(
					`search_config.properties.${wire.key}.required.test`,
					"no-case",
					slotOf(
						{
							entity: "module",
							uuid: ids.patients,
							slot: "search_input_required_when",
							member: { searchInputUuid: searchInput.uuid },
						},
						"no-case",
					),
					serializeWire(required, {
						target: "hq-json",
						interpolation: "no-case",
					}).text,
					suite(required),
				),
			);
		const validation = wire.validation?.test;
		if (validation !== undefined)
			slots.push(
				row(
					`search_config.properties.${wire.key}.validations.0.test`,
					"no-dots",
					slotOf(
						{
							entity: "module",
							uuid: ids.patients,
							slot: "search_input_validation_rule",
							member: { searchInputUuid: searchInput.uuid },
						},
						"no-dots",
					),
					serializeWire(validation, {
						target: "hq-json",
						interpolation: "no-dots",
					}).text,
					suite(validation),
				),
			);
	}
	writeFileSync(
		resolve(output, "reader-interpolation.json"),
		`${JSON.stringify({
			schemaVersion: 1,
			vectors: INTERPOLATION_VECTORS.map((vector) => ({
				name: vector.name,
				text: vector.text,
				caseXPath: vector.slot.caseXPath ?? null,
				interpolateDots: vector.slot.interpolateDots,
				port: interpolateHqXPath(vector.text, vector.slot),
			})),
			dots: DOT_VECTORS.map((vector) => ({
				name: vector.name,
				text: vector.text,
				replacement: vector.replacement,
				port: dotInterpolate(vector.text, vector.replacement),
			})),
			slots,
		})}\n`,
	);
}

// ProseValueRuntimeTest reads each calculated value a label holds through
// Core in every device zone, and requires the text Preview prints for it
// (lib/preview/engine/__tests__/proseValue.vectors.ts). Its two checked
// questions compose a validation message holding a value, alone and beside
// a reference, which Core reads through FormEntryPrompt.getConstraintText.
{
	const directory = resolve(output, "prose-values");
	mkdirSync(directory, { recursive: true });
	const doc = admitted("calculated value vectors", proseValueVectorDoc());
	writeFileSync(resolve(directory, "form.xml"), compiledForm(doc, 0, 0));
	writeFileSync(
		resolve(output, "prose-values.json"),
		`${JSON.stringify({
			schemaVersion: 1,
			form: "/expression/prose-values/form.xml",
			answers: Object.entries(PROSE_VALUE_ANSWERS).map(([id, value]) => ({
				question: `/data/${id}`,
				value,
			})),
			vectors: PROSE_VALUE_VECTORS.map((vector) => ({
				id: vector.id,
				question: `/data/${vector.id}`,
				text: vector.text,
			})),
			messages: PROSE_VALUE_MESSAGES.map((message) => ({
				id: message.id,
				question: `/data/${message.id}`,
				refused: "0",
				text: message.text,
			})),
		})}\n`,
	);
}

// ReaderSpellingRuntimeTest (run E1) reads each row of the reader's
// equivalence table (lib/commcare/reader/syntaxCompare.ts) through Core:
// both spellings of a vector parsed and evaluated over one instance.
writeFileSync(
	resolve(output, "reader-spelling.json"),
	`${JSON.stringify({ schemaVersion: 1, vectors: SPELLING_VECTORS })}\n`,
);

// ListFilterMatchRuntimeTest runs Core's own StringUtils.normalize and
// fuzzyMatch over the vectors Preview's port of the case list filter is held
// to (lib/preview/__tests__/fixtures/listFilterMatch.ts).
writeFileSync(
	resolve(output, "list-filter-match.json"),
	`${JSON.stringify({
		schemaVersion: 1,
		normalize: LIST_FILTER_NORMALIZE_VECTORS,
		fuzzy: LIST_FILTER_FUZZY_VECTORS,
	})}\n`,
);

console.log(
	`Produced ${pairs.length} private expression controls over ${Object.keys(lowered).length} lowered comparisons and ${CORE_DATE_PARITY.rows.length} date parity rows.`,
);
