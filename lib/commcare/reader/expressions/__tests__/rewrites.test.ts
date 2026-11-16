/**
 * The reader's print of a slot with a rewrite control: the emitter's own
 * print where the control withholds nothing, the print from before a
 * rewrite where it withholds that rewrite, and a report of every site the
 * print reaches. The failures this holds: a rewrite that has a switch
 * withheld and still printed; a site reached and not reported; a relocation
 * site that reports only where the tree stores an absolute read; a starting
 * value inside a repeat whose read of another question of the entry sits in
 * a row filter reported as `default-reads-current`, where the print reads
 * `row-predicate-current` (the two spellings differ on Core there); and a
 * byte of the emitter's print changed by the control's presence, held over
 * the emitter's own document corpora.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	ROW_DEFAULT_FORM,
	rowDefaultDoc,
	rowPredicateDoc,
} from "@/lib/commcare/__tests__/rowPredicateFixture";
import type {
	EmissionRewriteId,
	RewriteControl,
} from "@/lib/commcare/emissionRewrites";
import { moduleExpressionContexts } from "@/lib/commcare/expressionContext";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { emitNodesetFilter } from "@/lib/commcare/suite/case-list/nodesetFilter";
import { searchActionRelevant } from "@/lib/commcare/suite/case-list/shortDetail";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import type { WireExpr } from "@/lib/commcare/xpath/wire/tree";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import type {
	Expression,
	SlotContextRef,
	Term,
} from "@/lib/domain/expression/types";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import type { Uuid } from "@/lib/domain/uuid";
import { sameXPathText } from "../../syntaxCompare";
import type { ExpressionReadEnv } from "../index";
import { printSlot } from "../readExpression";
import { fieldNamed, readEnv } from "./expressionReadFixture";
import { corpusDocs, READ_BACK_CORPORA, storedSlots } from "./readBackCorpus";

const TABLE = "01890000-0000-7000-8000-000000000101" as LookupTableId;
const NAME = "01890000-0000-7000-8000-000000000102" as LookupColumnId;
const WEIGHT = "01890000-0000-7000-8000-000000000103" as LookupColumnId;

/** The table's rows, as the form prints them. */
const ROWS = "instance('districts')/districts_list/districts";

function env(): ExpressionReadEnv {
	return readEnv({
		lookup: new Map([
			[
				TABLE,
				{
					id: TABLE,
					name: "Districts",
					tag: "districts",
					columns: [
						{ id: NAME, wireName: "name", label: "Name", dataType: "text" },
						{
							id: WEIGHT,
							wireName: "weight",
							label: "Weight",
							dataType: "int",
						},
					],
				},
			],
		]) as ExpressionReadEnv["lookup"],
	});
}

const lit = (value: string | number): Expression => ({
	kind: "term",
	term: { kind: "literal", value },
});
const term = (one: Term): Expression => ({ kind: "term", term: one });
const column = (columnId: LookupColumnId): Expression =>
	term({ kind: "table-column", tableId: TABLE, columnId });
function field(uuid: Uuid, spelling?: "current" | "absolute"): Expression {
	return term({
		kind: "field",
		uuid,
		...(spelling === undefined ? {} : { spelling }),
	});
}
const withIdentity = (clause: Expression): Expression => ({
	kind: "and",
	clauses: [{ kind: "match-all" }, clause],
});

function app(): BlueprintDoc {
	return buildDoc({
		caseTypes: [{ name: "patient", properties: [{ name: "p", label: "P" }] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "text", id: "q1", label: "Q1" }),
							f({ kind: "datetime", id: "start", label: "Start" }),
							f({ kind: "datetime", id: "end", label: "End" }),
							f({ kind: "hidden", id: "h" }),
							f({
								kind: "single_select",
								id: "pick",
								label: "Pick",
								optionsSource: {
									kind: "lookup",
									tableId: TABLE,
									valueColumnId: NAME,
									labelColumnId: NAME,
								},
							}),
							f({
								kind: "repeat",
								id: "r",
								label: "Rounds",
								repeat_mode: "user_controlled",
								children: [
									f({ kind: "text", id: "k", label: "Kind" }),
									f({ kind: "hidden", id: "d" }),
								],
							}),
						],
					},
				],
			},
		],
	});
}

function moduleOf(doc: BlueprintDoc): Uuid {
	return doc.moduleOrder[0] as Uuid;
}

/** A print of `expression` in `ref`, with no control (`withhold` absent), or
 *  with one withholding `withhold` and recording every site it reaches. */
function printed(
	doc: BlueprintDoc,
	ref: SlotContextRef,
	expression: Expression,
	withhold?: readonly EmissionRewriteId[],
	readEnvironment: ExpressionReadEnv = env(),
) {
	const reached: EmissionRewriteId[] = [];
	const text = printSlot(doc, ref, expression, readEnvironment, {
		...(withhold === undefined
			? {}
			: {
					rewrites: {
						withhold: new Set(withhold),
						reached: (id) => reached.push(id),
					},
				}),
	});
	return { text, reached };
}

/** The emitter's print, the print with `id` withheld, and what each reached. */
function both(
	doc: BlueprintDoc,
	ref: SlotContextRef,
	expression: Expression,
	id: EmissionRewriteId,
	readEnvironment?: ExpressionReadEnv,
) {
	const own = printed(doc, ref, expression, undefined, readEnvironment);
	const applied = printed(doc, ref, expression, [], readEnvironment);
	const withheld = printed(doc, ref, expression, [id], readEnvironment);
	expect(applied.text).toBe(own.text);
	expect(own.reached).toEqual([]);
	expect(applied.reached).toContain(id);
	expect(withheld.reached).toContain(id);
	expect(withheld.text).not.toBe(applied.text);
	return { applied: applied.text, withheld: withheld.text };
}

/** `printed` is `expected` to the rule set's comparison, with the print in
 *  the failure message. */
function expectSyntax(
	printed: string,
	expected: string,
	ruleSet: "form" | "record" = "form",
): void {
	expect(sameXPathText(printed, expected, { ruleSet }), printed).toBe(true);
}

function fieldRef(
	doc: BlueprintDoc,
	id: string,
	slot: "calculate" | "default_value" | "relevant" | "lookup_options_source",
): SlotContextRef {
	return { entity: "field", uuid: fieldNamed(doc, id), slot } as SlotContextRef;
}

describe("a print under a rewrite control", () => {
	it("prints the emitter's own bytes where the control withholds nothing", () => {
		const doc = app();
		const comparison: Expression = {
			kind: "lt",
			left: field(fieldNamed(doc, "start")),
			right: field(fieldNamed(doc, "end")),
		};
		const ref = fieldRef(doc, "q1", "relevant");
		expect(printed(doc, ref, comparison, []).text).toBe(
			printed(doc, ref, comparison).text,
		);
	});

	it("prints a withheld instant comparison as the bare comparison", () => {
		const doc = app();
		const { withheld } = both(
			doc,
			fieldRef(doc, "q1", "relevant"),
			{
				kind: "lt",
				left: field(fieldNamed(doc, "start")),
				right: field(fieldNamed(doc, "end")),
			},
			"instant-comparison",
		);
		expectSyntax(withheld, "/data/start < /data/end");
	});

	describe("empty-rows-guard", () => {
		it("leaves a value read of a table's rows bare", () => {
			const doc = app();
			const read = `${ROWS}[name = /data/q1][1]/name`;
			const { applied, withheld } = both(
				doc,
				fieldRef(doc, "h", "calculate"),
				{
					kind: "table-lookup",
					tableId: TABLE,
					resultColumnId: NAME,
					where: {
						kind: "eq",
						left: column(NAME),
						right: field(fieldNamed(doc, "q1")),
					},
				},
				"empty-rows-guard",
			);
			expectSyntax(applied, `if(count(${ROWS}) > 0, ${read}, '')`);
			expectSyntax(withheld, read);
		});

		it("leaves a sum over a table's rows unguarded", () => {
			const doc = app();
			const { applied, withheld } = both(
				doc,
				fieldRef(doc, "h", "calculate"),
				{
					kind: "call",
					fn: "sum",
					args: [
						{
							kind: "project",
							of: { kind: "table-rows", tableId: TABLE, where: [] },
							value: { kind: "table-column", tableId: TABLE, columnId: WEIGHT },
						},
					],
				},
				"empty-rows-guard",
			);
			expectSyntax(applied, `if(count(${ROWS}) > 0, sum(${ROWS}/weight), 0)`);
			expectSyntax(withheld, `sum(${ROWS}/weight)`);
		});

		it("leaves a weighted checklist's pair of table reads unguarded", () => {
			const doc = app();
			const rows = (columnId: LookupColumnId): Expression => ({
				kind: "project",
				of: { kind: "table-rows", tableId: TABLE, where: [] },
				value: { kind: "table-column", tableId: TABLE, columnId },
			});
			const { withheld } = both(
				doc,
				fieldRef(doc, "h", "calculate"),
				{
					kind: "call",
					fn: "weighted-checklist",
					args: [lit(1), lit(2), rows(NAME), rows(WEIGHT)],
				},
				"empty-rows-guard",
			);
			expectSyntax(
				withheld,
				`weighted-checklist(1, 2, ${ROWS}/name, ${ROWS}/weight)`,
			);
		});
	});

	describe("absent-session-value-guard", () => {
		it("leaves the app's language bare", () => {
			const doc = app();
			const language =
				"instance('commcaresession')/session/context/applanguage";
			const { applied, withheld } = both(
				doc,
				fieldRef(doc, "h", "calculate"),
				term({ kind: "session-context", field: "applanguage" }),
				"absent-session-value-guard",
			);
			expectSyntax(applied, `if(count(${language}) > 0, ${language}, '')`);
			expectSyntax(withheld, language);
		});

		it("leaves the screen width bare in a menu's display condition", () => {
			const doc = app();
			const width = "instance('commcaresession')/session/context/window_width";
			const { applied, withheld } = both(
				doc,
				{
					entity: "module",
					uuid: moduleOf(doc),
					slot: "module_display_condition",
				},
				{
					kind: "gt",
					left: term({ kind: "session-context", field: "window_width" }),
					right: lit(400),
				},
				"absent-session-value-guard",
			);
			expectSyntax(
				applied,
				`if(count(${width}) > 0, ${width}, '') > 400`,
				"record",
			);
			expectSyntax(withheld, `${width} > 400`, "record");
		});

		it("prints the case list's search text as its bare path", () => {
			const doc = app();
			const text = "instance('commcaresession')/session/data/stringquery";
			const { applied, withheld } = both(
				doc,
				fieldRef(doc, "h", "calculate"),
				{ kind: "case-list-search-text" },
				"absent-session-value-guard",
			);
			expectSyntax(applied, `if(count(${text}) > 0, ${text}[1], '')`);
			expectSyntax(withheld, text);
		});
	});

	describe("filter-identities-dropped", () => {
		const pIsX: Expression = {
			kind: "eq",
			left: term({ kind: "prop", caseType: "patient", property: "p" }),
			right: lit("x"),
		};
		const userIsA: Expression = {
			kind: "eq",
			left: term({ kind: "session-context", field: "username" }),
			right: lit("a"),
		};
		const username = "instance('commcaresession')/session/context/username";

		it("keeps the case list filter's identity in HQ's JSON", () => {
			const doc = app();
			const { applied, withheld } = both(
				doc,
				{ entity: "module", uuid: moduleOf(doc), slot: "case_list_filter" },
				withIdentity(pIsX),
				"filter-identities-dropped",
			);
			expectSyntax(applied, "p = 'x'", "record");
			expectSyntax(withheld, "true() and p = 'x'", "record");
		});

		it("keeps the case list filter's identity in the suite's nodeset", () => {
			const doc = app();
			const context = moduleExpressionContexts(
				doc,
				moduleOf(doc),
				lookupWireNaming([]),
			)({ slot: "case_list_filter" });
			const print = (rewrites?: RewriteControl) =>
				suiteText(
					emitNodesetFilter(
						withIdentity(pIsX),
						context,
						undefined,
						undefined,
						rewrites,
					),
				);
			const { applied, withheld } = controlled(print);
			expectSyntax(applied, "p = 'x'", "record");
			expectSyntax(withheld, "true() and p = 'x'", "record");
		});

		it("keeps a lookup-backed select's row filter identity", () => {
			const doc = app();
			const { applied, withheld } = both(
				doc,
				fieldRef(doc, "pick", "lookup_options_source"),
				withIdentity({
					kind: "eq",
					left: column(NAME),
					right: field(fieldNamed(doc, "q1")),
				}),
				"filter-identities-dropped",
			);
			expectSyntax(applied, "name = /data/q1");
			expectSyntax(withheld, "true() and name = /data/q1");
		});

		it("keeps a table lookup's row filter identity", () => {
			const doc = app();
			const { applied, withheld } = both(
				doc,
				fieldRef(doc, "h", "calculate"),
				{
					kind: "table-lookup",
					tableId: TABLE,
					resultColumnId: NAME,
					where: withIdentity({
						kind: "eq",
						left: column(NAME),
						right: field(fieldNamed(doc, "q1")),
					}),
				},
				"filter-identities-dropped",
			);
			const guarded = (predicate: string) =>
				`if(count(${ROWS}) > 0, ${ROWS}[${predicate}][1]/name, '')`;
			expectSyntax(applied, guarded("name = /data/q1"));
			expectSyntax(withheld, guarded("true() and name = /data/q1"));
		});

		it("keeps the search button's condition identity in HQ's JSON", () => {
			const doc = app();
			const { applied, withheld } = both(
				doc,
				{
					entity: "module",
					uuid: moduleOf(doc),
					slot: "search_button_display_condition",
				},
				withIdentity(userIsA),
				"filter-identities-dropped",
			);
			expectSyntax(applied, `${username} = 'a'`, "record");
			expectSyntax(withheld, `true() and ${username} = 'a'`, "record");
		});

		it("keeps the search button's condition identity in the suite", () => {
			const doc = app();
			const expressions = moduleExpressionContexts(
				doc,
				moduleOf(doc),
				lookupWireNaming([]),
			);
			const print = (rewrites?: RewriteControl) =>
				suiteText(
					searchActionRelevant(
						withIdentity(userIsA),
						expressions,
						undefined,
						rewrites,
					),
				);
			const { applied, withheld } = controlled(print);
			expectSyntax(applied, `${username} = 'a'`, "record");
			expectSyntax(withheld, `true() and ${username} = 'a'`, "record");
		});
	});

	describe("the two current() relocations", () => {
		it("reports a row filter's relocation of a read it relocates", () => {
			const doc = rowPredicateDoc();
			const ref = fieldRef(doc, "indexed", "calculate");
			const kind = fieldNamed(doc, "kind");
			for (const spelling of [undefined, "absolute"] as const) {
				const rows: Expression = {
					kind: "count",
					via: {
						kind: "cases",
						source: "casedb",
						where: [
							{
								kind: "eq",
								left: term({
									kind: "prop",
									caseType: "visit",
									property: "kind_text",
								}),
								right: field(kind, spelling),
							},
						],
					},
				};
				const { applied, withheld } = both(
					doc,
					ref,
					rows,
					"row-predicate-current",
					readEnv(),
				);
				expect(applied).toContain("current()/../kind");
				expect(withheld).toContain("/data/visits/kind");
				expect(withheld).not.toContain("current()");
				const reached = printed(doc, ref, rows, [], readEnv()).reached;
				expect(reached).not.toContain("default-reads-current");
			}
		});

		it("reports a default's relocation of a read it relocates", () => {
			const doc = app();
			const ref = fieldRef(doc, "end", "default_value");
			const start = fieldNamed(doc, "start");
			for (const spelling of [undefined, "absolute"] as const) {
				const { applied, withheld } = both(
					doc,
					ref,
					field(start, spelling),
					"default-reads-current",
				);
				expect(applied).toContain("current()");
				expect(withheld).not.toContain("current()");
				const reached = printed(doc, ref, field(start, spelling), []).reached;
				expect(reached).not.toContain("row-predicate-current");
			}
		});

		it("leaves a read stored current() as it is at both sites, withheld or not", () => {
			// Nothing relocates a read the author spelled `current()`: its print
			// is the one it had before the rewrite existed, and it reaches neither.
			const rowDoc = rowPredicateDoc();
			const rowRef = fieldRef(rowDoc, "indexed", "calculate");
			const rows: Expression = {
				kind: "count",
				via: {
					kind: "cases",
					source: "casedb",
					where: [
						{
							kind: "eq",
							left: term({
								kind: "prop",
								caseType: "visit",
								property: "kind_text",
							}),
							right: field(fieldNamed(rowDoc, "kind"), "current"),
						},
					],
				},
			};
			const defaultDoc = app();
			const defaultRef = fieldRef(defaultDoc, "end", "default_value");
			const start = field(fieldNamed(defaultDoc, "start"), "current");
			for (const [doc, ref, expression, env] of [
				[rowDoc, rowRef, rows, readEnv()],
				[defaultDoc, defaultRef, start, undefined],
			] as const) {
				const applied = printed(doc, ref, expression, [], env);
				const withheld = printed(
					doc,
					ref,
					expression,
					["row-predicate-current", "default-reads-current"],
					env,
				);
				expect(applied.text).toContain("current()");
				expect(withheld.text).toBe(applied.text);
				expect(applied.reached).not.toContain("row-predicate-current");
				expect(applied.reached).not.toContain("default-reads-current");
			}
		});

		it("reports a default in a repeat that reads a filtered table as a row filter's relocation", () => {
			const doc = app();
			const { applied, withheld } = both(
				doc,
				fieldRef(doc, "d", "default_value"),
				{
					kind: "count",
					via: {
						kind: "table-rows",
						tableId: TABLE,
						where: [
							{
								kind: "eq",
								left: column(NAME),
								right: field(fieldNamed(doc, "k")),
							},
						],
					},
				},
				"row-predicate-current",
			);
			expect(applied).toContain("current()/../k");
			expect(withheld).toContain("/data/r/k");
			const reached = printed(
				doc,
				fieldRef(doc, "d", "default_value"),
				{
					kind: "count",
					via: {
						kind: "table-rows",
						tableId: TABLE,
						where: [
							{
								kind: "eq",
								left: column(NAME),
								right: field(fieldNamed(doc, "k")),
							},
						],
					},
				},
				[],
			).reached;
			expect(reached).not.toContain("default-reads-current");
		});

		it("reports a default in a repeat that reads the filtered place list as a row filter's relocation", () => {
			const doc = rowDefaultDoc();
			const named = fieldNamed(doc, "named");
			const stored = doc.fields[named];
			const expression =
				stored !== undefined && "default_value" in stored
					? (stored.default_value as Expression | undefined)
					: undefined;
			if (expression === undefined)
				throw new Error("The fixture's `named` has no starting value.");
			expect(Object.keys(doc.forms)).toContain(ROW_DEFAULT_FORM);
			const ref = fieldRef(doc, "named", "default_value");
			both(doc, ref, expression, "row-predicate-current", readEnv());
			expect(
				printed(doc, ref, expression, [], readEnv()).reached,
			).not.toContain("default-reads-current");
		});
	});
});

/** A suite print of a site that builds its own wire tree. */
function suiteText(wire: WireExpr | undefined): string {
	return wire === undefined
		? ""
		: serializeWire(wire, { target: "suite" }).text;
}

/** A suite site's print with no control, with one withholding nothing and
 *  with one withholding `filter-identities-dropped`. */
function controlled(print: (rewrites?: RewriteControl) => string) {
	const reached: EmissionRewriteId[] = [];
	const control = (withhold: EmissionRewriteId[]): RewriteControl => ({
		withhold: new Set(withhold),
		reached: (id) => reached.push(id),
	});
	const own = print();
	const applied = print(control([]));
	expect(applied).toBe(own);
	expect(reached).toContain("filter-identities-dropped");
	reached.length = 0;
	const withheld = print(control(["filter-identities-dropped"]));
	expect(reached).toContain("filter-identities-dropped");
	expect(withheld).not.toBe(applied);
	return { applied, withheld };
}

/** Documents per corpus the sweep prints. */
const SWEEP_DOCS = 12;

/** What a print gave: its text, or the sentence it threw. */
function outcome(print: () => string): string {
	try {
		return `text:${print()}`;
	} catch (error) {
		return `threw:${error instanceof Error ? error.message : String(error)}`;
	}
}

describe("a control that withholds nothing changes no byte", () => {
	for (const corpus of READ_BACK_CORPORA)
		it(`over the ${corpus.name} corpus`, { timeout: 60_000 }, () => {
			let printedSlots = 0;
			for (const doc of corpusDocs(corpus, SWEEP_DOCS)) {
				const readEnvironment = readEnv();
				for (const { ref, expression } of storedSlots(doc)) {
					const own = outcome(() =>
						printSlot(doc, ref, expression, readEnvironment),
					);
					const applied = outcome(() =>
						printSlot(doc, ref, expression, readEnvironment, {
							rewrites: { withhold: new Set() },
						}),
					);
					expect(applied, `${ref.slot} of ${ref.uuid}`).toBe(own);
					if (own.startsWith("text:")) printedSlots++;
					if (ref.entity !== "module") continue;
					const expressions = moduleExpressionContexts(
						doc,
						ref.uuid,
						lookupWireNaming([]),
					);
					if (ref.slot === "case_list_filter") {
						const nodeset = (rewrites?: RewriteControl) =>
							outcome(() =>
								suiteText(
									emitNodesetFilter(
										expression,
										expressions({ slot: "case_list_filter" }),
										undefined,
										undefined,
										rewrites,
									),
								),
							);
						expect(nodeset({ withhold: new Set() })).toBe(nodeset());
					}
					if (ref.slot === "search_button_display_condition") {
						const relevant = (rewrites?: RewriteControl) =>
							outcome(() =>
								suiteText(
									searchActionRelevant(
										expression,
										expressions,
										undefined,
										rewrites,
									),
								),
							);
						expect(relevant({ withhold: new Set() })).toBe(relevant());
					}
				}
			}
			expect(printedSlots).toBeGreaterThan(0);
		});
});
